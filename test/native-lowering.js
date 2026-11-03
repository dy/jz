import test from 'tst'
import { is, ok } from 'tst/assert.js'
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { compile as compileWat } from 'watr'
import { CFLAGS, codegen, declareV128, PROVIDED, sysroot, toolchain, wasm2native } from '../scripts/native/compile.mjs'

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
  ok(/#define i32_store_default32\(mem, addr, val\) i32_store\(mem, addr, val\)/.test(out), 'and the _default32 forms newer WABT calls')
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
    const out = args[args.indexOf('-o') + 1]
    writeFileSync(out, ${JSON.stringify(fixture)})
    writeFileSync(out.replace(/\\.c$/, '.h'), '#include "wasm-rt.h"\\n')
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

// WABT writes every multi-value result struct into the header, SIMDe's v128 only for
// v128 globals, imports and exports (jzczhz's prologue returns 58 hoisted splats).
const V128_RESULTS = `(module
  (func $pair (param f64) (result i32 v128) (i32.const 7) (f64x2.splat (local.get 0)))
  (func (export "_start") (local v128)
    (call $pair (f64.const 2.5)) (local.set 0)
    (if (i32.ne (i32.const 7)) (then unreachable))
    (if (f64.ne (f64x2.extract_lane 1 (local.get 0)) (f64.const 2.5)) (then unreachable))))`
test('native wasm2c header: v128 declared where a multi-value result names it', () => {
  const head = '#include "wasm-rt.h"\n\nstruct wasm_multi_io { u32 i0; v128 o1; };\n'
  const out = declareV128(head)
  ok(out.indexOf('typedef simde_v128_t v128;') < out.indexOf('v128 o1'), 'v128 is defined before the struct names it')
  ok(out.includes('#ifndef WASM_RT_SIMD_TYPE_DEFINED'), 'behind the guard the generated source checks')
  is(declareV128(out), out, 'a declared header stays as it is')
  is(declareV128('#include "wasm-rt.h"\n'), '#include "wasm-rt.h"\n', 'a header without v128 stays as it is')
})
const SIMDE = !NATIVE.error && NATIVE.include.some(p => existsSync(join(p, 'simde/wasm/simd128.h')))
test('native executable: an internal function returning a v128 among several values', { skip: !SIMDE }, () => scratchDir('v128', dir => {
  const wasm = join(dir, 'pair.wasm'), bin = join(dir, 'pair')
  writeFileSync(wasm, compileWat(V128_RESULTS))
  wasm2native(wasm, bin, { dir, tools: NATIVE })
  const r = spawnSync(bin, { encoding: 'utf8' })
  is(r.status, 0, `the struct-returned v128 carries its lanes: ${r.stderr}`)
}))

test('native executable: a CC carrying arguments, and a C failure blamed on no tail call', { skip: !!NATIVE.error }, () => scratchDir('cc', dir => {
  const js = join(dir, 'hi.mjs'), bin = join(dir, 'hi')
  writeFileSync(js, `console.log('hi')\n`)
  const cc = CC => spawnSync(process.execPath, [COMPILE, js, '-o', bin], { env: { ...process.env, CC }, encoding: 'utf8' })
  is(cc(` ${NATIVE.cc}  -DJZ_CC_ARG `).status, 0, 'CC="<compiler> <flag>" builds, as CC="zig cc" does')
  is(execFileSync(bin, { encoding: 'utf8' }), 'hi\n', 'and runs')
  const bad = cc(`${NATIVE.cc} -fjz-no-such-flag`)
  is(bad.status, 1, 'a flag the compiler rejects fails the build')
  ok(!/tail call/.test(bad.stderr), 'without blaming a tail call the module does not make')
}))

// jz's tag dispatch (bench/shapes' measure): an if-chain on one i32 tag, each arm reading
// its own fields of a 20-byte record. clang folds the chain into a switch, which x86 lowers
// from 4 cases to one indirect jump through a table: a branch predictor learns that far
// worse than the branches V8 runs once the stream repeats (shapes: 7.9× V8's time on Zen 5).
const F = n => `(i32.load offset=${4 * n} (local.get $p))`
const ARMS = [`(i32.add ${F(1)} ${F(2)})`, `(i32.mul ${F(1)} (i32.mul ${F(1)} (i32.const 3)))`, `(i32.mul ${F(1)} ${F(2)})`,
  `(i32.sub ${F(4)} ${F(2)})`, `(i32.add (i32.add ${F(1)} ${F(2)}) ${F(3)})`, `(i32.sub (i32.mul ${F(1)} ${F(2)}) ${F(3)})`,
  `(i32.add (i32.mul ${F(1)} ${F(2)}) ${F(1)})`, `(i32.mul ${F(3)} (i32.mul ${F(2)} ${F(2)}))`]
const chain = (i = 0) => i === ARMS.length - 1 ? ARMS[i]
  : `(if (result i32) (i32.eq (local.get $k) (i32.const ${i})) (then ${ARMS[i]}) (else ${chain(i + 1)}))`
// Records i = 0..7: tag i, fields i+1..i+4. _start traps unless dispatch answers `expect`.
const RECORDS = Array.from({ length: 8 }, (_, i) => [i, i + 1, i + 2, i + 3, i + 4]).flat()
  .map(v => `\\${v.toString(16).padStart(2, '0')}\\00\\00\\00`).join('')
const DISPATCH = expect => `(module
  (memory (export "memory") 1)
  (data (i32.const 0) "${RECORDS}")
  (func $dispatch (export "dispatch") (param $p i32) (param $end i32) (result i32) (local $k i32) (local $s i32)
    (block $done (loop $next
      (br_if $done (i32.ge_u (local.get $p) (local.get $end)))
      (local.set $k (i32.load (local.get $p)))
      (local.set $s (i32.add (local.get $s) ${chain()}))
      (local.set $p (i32.add (local.get $p) (i32.const 20)))
      (br $next)))
    (local.get $s))
  (func (export "_start")
    (if (i32.ne (call $dispatch (i32.const 0) (i32.const 160)) (i32.const ${expect})) (then unreachable))))`
// x86 code from any host clang can target it: natively, or the macOS SDK's x86_64 slice.
const X86 = process.arch === 'x64' ? [] : process.platform === 'darwin' ? ['-target', 'x86_64-apple-macos'] : null
const OBJDUMP = spawnSync('objdump', ['--version'], { stdio: 'ignore' }).status === 0
const indirectJumps = asm => (asm.match(/\bjmp[a-z]*\s+\*/g) || []).length
test('native executable: a tag dispatch stays branches, not an x86 jump table', { skip: !!NATIVE.error }, () => scratchDir('dispatch', dir => {
  const expect = new WebAssembly.Instance(new WebAssembly.Module(compileWat(DISPATCH(0)))).exports.dispatch(0, 160)
  const wasm = join(dir, 'dispatch.wasm'), bin = join(dir, 'dispatch')
  writeFileSync(wasm, compileWat(DISPATCH(expect)))
  wasm2native(wasm, bin, { dir, tools: NATIVE })
  is(spawnSync(bin).status, 0, `native answers V8's ${expect}`)
  if (!X86 || !codegen(NATIVE.cc, []).length) return console.log('# x86 lowering unchecked: needs clang and an x86 target')
  // The module's C as x86 assembly: the control makes the table the default build avoids.
  const [cc, ...ccArgs] = NATIVE.cc.trim().split(/\s+/)
  const asm = flags => execFileSync(cc, [...ccArgs, ...flags, ...X86, ...sysroot(), ...[dir, ...NATIVE.include].map(p => `-I${p}`),
    '-S', join(dir, 'jz.c'), '-o', '-'], { encoding: 'utf8', maxBuffer: 64 << 20 })
  ok(indirectJumps(asm([...CFLAGS, '-mllvm', '-min-jump-table-entries=4'])) > 0, 'control: from 4 cases x86 jumps through a table')
  is(indirectJumps(asm([...codegen(NATIVE.cc, CFLAGS), ...CFLAGS])), 0, 'the native build keeps the chain branches')
  // With LTO the linker runs codegen: the option must reach it there.
  if (!OBJDUMP) return console.log('# LTO lowering unchecked: no objdump')
  const lto = [...CFLAGS, '-flto', ...X86]
  const jumps = extra => {
    const out = join(dir, 'dispatch-lto')
    wasm2native(wasm, out, { dir, cflags: [...lto, ...extra], tools: NATIVE })
    if (!X86.length) is(spawnSync(out).status, 0, 'the LTO build answers as V8')
    return indirectJumps(execFileSync('objdump', ['-d', out], { encoding: 'utf8', maxBuffer: 256 << 20 }))
  }
  ok(jumps([]) < jumps(codegen(NATIVE.cc, lto, ['-min-jump-table-entries=4'])), 'under LTO too: fewer indirect jumps than the 4-case control')
}))

// jz's min of three (bench/levenshtein's DP): a select on the loop-carried cell, which V8 keeps
// a cmov. x86's cmov converter would branch on it, and a DP's branch mispredicts.
const DP = 64, DP_DATA = Array.from({ length: 2 * DP }, (_, i) => `\\0${(Math.imul(i + 1, 2654435761) >>> 29) & 3}`).join('')
const MIN3 = expect => `(module
  (memory (export "memory") 1)
  (data (i32.const 0) "${DP_DATA}")
  (func $lev (export "lev") (result i32) (local $i i32) (local $j i32) (local $ai i32) (local $diag i32) (local $up i32) (local $m i32) (local $ins i32) (local $sub i32)
    (loop $init
      (i32.store offset=256 (i32.shl (local.get $j) (i32.const 2)) (local.get $j))
      (br_if $init (i32.le_u (local.tee $j (i32.add (local.get $j) (i32.const 1))) (i32.const ${DP}))))
    (local.set $i (i32.const 1))
    (loop $rows
      (local.set $diag (i32.load offset=256 (i32.const 0)))
      (i32.store offset=256 (i32.const 0) (local.get $i))
      (local.set $ins (local.get $i))
      (local.set $ai (i32.load8_u (i32.sub (local.get $i) (i32.const 1))))
      (local.set $j (i32.const 1))
      (loop $cells
        (local.set $up (i32.load offset=256 (i32.shl (local.get $j) (i32.const 2))))
        (local.set $sub (i32.add (local.get $diag) (i32.ne (local.get $ai) (i32.load8_u offset=${DP - 1} (local.get $j)))))
        (local.set $m (i32.add (local.get $up) (i32.const 1)))
        (local.set $ins (i32.add (local.get $ins) (i32.const 1)))
        (local.set $m (select (local.get $ins) (local.get $m) (i32.lt_s (local.get $ins) (local.get $m))))
        (local.set $m (select (local.get $sub) (local.get $m) (i32.lt_s (local.get $sub) (local.get $m))))
        (local.set $diag (local.get $up))
        (local.set $ins (local.get $m))
        (i32.store offset=256 (i32.shl (local.get $j) (i32.const 2)) (local.get $m))
        (br_if $cells (i32.le_u (local.tee $j (i32.add (local.get $j) (i32.const 1))) (i32.const ${DP}))))
      (br_if $rows (i32.le_u (local.tee $i (i32.add (local.get $i) (i32.const 1))) (i32.const ${DP}))))
    (i32.load offset=${256 + 4 * DP} (i32.const 0)))
  (func (export "_start") (if (i32.ne (call $lev) (i32.const ${expect})) (then unreachable))))`
test('native executable: a DP min stays a cmov on x86, not a branch', { skip: !!NATIVE.error }, () => scratchDir('min3', dir => {
  const expect = new WebAssembly.Instance(new WebAssembly.Module(compileWat(MIN3(0)))).exports.lev()
  const wasm = join(dir, 'min3.wasm'), bin = join(dir, 'min3')
  writeFileSync(wasm, compileWat(MIN3(expect)))
  wasm2native(wasm, bin, { dir, tools: NATIVE })
  is(spawnSync(bin).status, 0, `native answers V8's ${expect}`)
  if (!X86 || !codegen(NATIVE.cc, []).length) return console.log('# x86 lowering unchecked: needs clang and an x86 target')
  // An x86 model the converter acts on (it weighs each CPU's latencies), whatever the host.
  const x86 = [...CFLAGS, ...X86, '-march=x86-64-v3']
  const [cc, ...ccArgs] = NATIVE.cc.trim().split(/\s+/)
  const cmovs = s => (s.match(/\bcmov/g) || []).length
  const asm = flags => cmovs(execFileSync(cc, [...ccArgs, ...flags, ...sysroot(), ...[dir, ...NATIVE.include].map(p => `-I${p}`),
    '-S', join(dir, 'jz.c'), '-o', '-'], { encoding: 'utf8', maxBuffer: 64 << 20 }))
  const branched = asm(x86), kept = asm([...codegen(NATIVE.cc, x86), ...x86])
  ok(branched < kept, `control: the converter branches on ${kept - branched} of ${kept} cmovs; the native build keeps them`)
  // With LTO the linker runs codegen: the option must reach it there.
  if (!OBJDUMP) return console.log('# LTO lowering unchecked: no objdump')
  const lto = [...x86, '-flto']
  const linked = extra => {
    const out = join(dir, 'min3-lto')
    wasm2native(wasm, out, { dir, cflags: [...lto, ...extra], tools: NATIVE })
    if (!X86.length) is(spawnSync(out).status, 0, 'the LTO build answers as V8')
    return cmovs(execFileSync('objdump', ['-d', out], { encoding: 'utf8', maxBuffer: 256 << 20 }))
  }
  ok(linked([]) > linked(codegen(NATIVE.cc, lto, ['-x86-cmov-converter=true'])), 'under LTO too: more cmovs than the converter leaves')
}))

// The postprocess every native build gets on real wasm2c output: once preprocessed, no load or
// store reads the memory base from the instance; each goes through the hoisted `_md`.
const ACCESS = `(module
  (memory (export "memory") 1)
  (func (export "_start")
    (i32.store (i32.const 0) (i32.const 7))
    (i64.store offset=8 (i32.const 0) (i64.extend_i32_u (i32.load (i32.const 0))))
    (f64.store offset=16 (i32.const 0) (f64.load offset=8 (i32.const 0)))
    (i32.store8 offset=24 (i32.const 0) (i32.load16_u offset=16 (i32.const 0)))
    (if (i32.ne (i32.load8_u offset=24 (i32.const 0)) (i32.const 7)) (then unreachable))))`
// A load past the one page, its value used: it traps, through guard pages or a bounds check.
const OOB = `(module
  (memory (export "memory") 1)
  (func (export "_start") (if (i32.eq (i32.load (i32.const 65536)) (i32.const 7)) (then unreachable))))`
test('native wasm2c postprocess: every load and store goes through the hoisted memory base', { skip: !!NATIVE.error }, () => scratchDir('md', dir => {
  const wasm = join(dir, 'access.wasm'), bin = join(dir, 'access')
  writeFileSync(wasm, compileWat(ACCESS))
  wasm2native(wasm, bin, { dir, tools: NATIVE })
  is(spawnSync(bin).status, 0, 'loads and stores of each width agree')
  const [cc, ...ccArgs] = NATIVE.cc.trim().split(/\s+/)
  const c = execFileSync(cc, [...ccArgs, '-E', ...sysroot(), ...[dir, ...NATIVE.include].map(p => `-I${p}`), join(dir, 'jz.c')],
    { encoding: 'utf8', maxBuffer: 64 << 20 })
  is(c.match(/\b\w*(?:load|store)\w*\(&instance->w2c_memory\b/g), null, 'no helper takes the instance memory')
  ok(/__builtin_memcpy\(_md \+/.test(c), 'the accesses use _md')
  // The shadows hold under guard pages only: a bounds-checked build keeps WABT's checks.
  writeFileSync(wasm, compileWat(OOB))
  for (const [mode, flags] of [['guard pages', []], ['bounds checks', ['-DWASM_RT_MEMCHECK_BOUNDS_CHECK']]]) {
    wasm2native(wasm, bin, { dir, cflags: [...CFLAGS, ...flags], tools: NATIVE })
    const r = spawnSync(bin, { encoding: 'utf8' })
    ok(r.status === 134 && /wasm trap: .*bounds/i.test(r.stderr), `${mode}: an out-of-bounds load traps (${r.status} ${r.signal ?? ''} ${r.stderr.trim()})`)
  }
}))
