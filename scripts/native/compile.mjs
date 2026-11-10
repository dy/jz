#!/usr/bin/env node
/**
 * jz program → native executable: jz --host wasi → wasm2c → C compiler, linked
 * with the WASI Preview 1 shim in wasi.c. The bench's jz-w2c lane uses the same
 * toolchain discovery, translation and shim.
 *
 *   node scripts/native/compile.mjs host.js -o host [jz options]
 *   node scripts/native/compile.mjs host.wasm -o host    # from jz host.js --host wasi
 *
 * Environment: WABT_DIR (a WABT checkout or install prefix) or WABT_W2C_DIR (its
 * wasm2c runtime directory, share/wabt/wasm2c in a release); otherwise the wasm2c
 * on PATH and the usual install prefixes. CC (default clang, else cc; may carry arguments, as "zig cc"), CFLAGS
 * (appended), SIMDE_DIR (SIMDe include root, for programs that vectorize).
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const CLI = resolve(HERE, '../../cli.js')
const SHIM = join(HERE, 'wasi.c')
/** Hoists the memory base and drops WABT's load barriers where guard pages allow (see the file). */
export const POSTPROCESS = join(HERE, 'postprocess-watr.awk')
/** The wasi_snapshot_preview1 imports wasi.c implements: every one jz emits. */
export const PROVIDED = ['fd_read', 'fd_write', 'fd_close', 'fd_filestat_get', 'path_open', 'clock_time_get', 'random_get', 'proc_exit']
/** wasm2c output keeps IEEE semantics only without contraction (no fused multiply-add). */
export const CFLAGS = ['-O3', '-ffp-contract=off']
const RUNTIME = ['wasm-rt-impl.c', 'wasm-rt-mem-impl.c', 'wasm-rt-exceptions-impl.c']
const PREFIXES = ['/opt/homebrew/opt/wabt', '/usr/local/opt/wabt', '/usr/local', '/usr']

const onPath = cmd => {
  const r = spawnSync('which', [cmd], { encoding: 'utf8' })
  return r.status === 0 ? r.stdout.trim() : null
}
const real = p => { try { return realpathSync(p) } catch { return p } }
const file = p => existsSync(p) && statSync(p).isFile()

/** -isysroot for the macOS SDK: a non-Apple clang (Homebrew's) may look for an SDK
 *  version that is not installed and then finds no <stdio.h>. xcrun names the real
 *  one; the Command Line Tools' unversioned link is the fallback. */
let sdk
export const sysroot = () => {
  if (process.platform !== 'darwin') return []
  if (sdk === undefined) {
    const r = spawnSync('xcrun', ['--show-sdk-path'], { encoding: 'utf8' })
    sdk = [r.status === 0 && r.stdout.trim(), '/Library/Developer/CommandLineTools/SDKs/MacOSX.sdk'].find(p => p && existsSync(p)) || null
  }
  return sdk ? ['-isysroot', sdk] : []
}

/**
 * Locate wasm2c, its runtime sources and headers, SIMDe and a C compiler.
 * @returns {{wasm2c: string, runtime: string, include: string[], cc: string} | {error: string}}
 */
export function toolchain(env = process.env) {
  const isRuntime = dir => !!dir && file(join(dir, 'wasm-rt-impl.c'))
  if (env.WABT_W2C_DIR && !isRuntime(env.WABT_W2C_DIR))
    return { error: `WABT_W2C_DIR=${env.WABT_W2C_DIR} holds no wasm-rt-impl.c (point it at WABT's wasm2c runtime directory)` }
  if (env.WABT_DIR && !env.WABT_W2C_DIR && !isRuntime(join(env.WABT_DIR, 'wasm2c')) && !isRuntime(join(env.WABT_DIR, 'share/wabt/wasm2c')))
    return { error: `WABT_DIR=${env.WABT_DIR} is neither a WABT checkout (wasm2c/) nor an install prefix (share/wabt/wasm2c/)` }
  const pathBin = onPath('wasm2c')
  const runtime = [
    env.WABT_W2C_DIR,
    env.WABT_DIR && join(env.WABT_DIR, 'wasm2c'),
    env.WABT_DIR && join(env.WABT_DIR, 'share/wabt/wasm2c'),
    // A release keeps bin/ beside share/wabt/wasm2c; a checkout keeps bin/ beside wasm2c/.
    ...(pathBin ? ['../share/wabt/wasm2c', '../wasm2c'].map(p => resolve(dirname(real(pathBin)), p)) : []),
    ...PREFIXES.map(p => join(p, 'share/wabt/wasm2c')),
  ].find(isRuntime)
  if (!runtime) return { error: 'wasm2c runtime not found: install WABT (brew install wabt, or a release from https://github.com/WebAssembly/wabt/releases) and set WABT_DIR to it if it is not on PATH' }
  // The translator beside the runtime matches its version; PATH's is the fallback.
  const wasm2c = [env.WABT_DIR && join(env.WABT_DIR, 'bin/wasm2c'), resolve(runtime, '../../../bin/wasm2c'), resolve(runtime, '../bin/wasm2c')]
    .find(p => p && file(p)) || (pathBin && 'wasm2c')
  if (!wasm2c) return { error: `wasm2c not found beside ${runtime} or on PATH` }
  // A checkout keeps wasm-rt.h beside the runtime; a release under <prefix>/include.
  const headers = env.WABT_INCLUDE_DIR || (file(join(runtime, 'wasm-rt.h')) ? runtime : resolve(runtime, '../../../include'))
  const simde = [env.SIMDE_DIR, resolve(runtime, '../third_party/simde'), '/opt/homebrew/include', '/usr/local/include']
    .find(p => p && file(join(p, 'simde/wasm/simd128.h')))
  const cc = env.CC || (onPath('clang') ? 'clang' : onPath('cc') ? 'cc' : null)
  if (!cc) return { error: 'no C compiler: install clang or set CC' }
  return { wasm2c, runtime, include: [...new Set([runtime, headers, simde].filter(Boolean))], cc }
}

const run = (cmd, args) => {
  try { execFileSync(cmd, args, { stdio: 'pipe', maxBuffer: 64 << 20 }) }
  catch (e) {
    const err = String(e.stderr || e.message).trim()
    const hint = /simde/.test(err) ? '\nThe program uses SIMD: install SIMDe (brew install simde, apt install libsimde-dev) or set SIMDE_DIR, or compile with --no-simd.' : ''
    throw Error(`${cmd} failed:\n${err}${hint}`)
  }
}

/** WABT (through 1.0.42) declares every multi-value result struct in the generated
 *  header, but writes SIMDe's `v128` there only for v128 globals, imports and exports:
 *  an internal function returning several values, a v128 among them, names `v128` in
 *  the header before anything defines it. Give that header the declaration WABT
 *  writes when it does see the need; the source's own copy sits behind the same guard. */
export const declareV128 = h => /\bv128\b/.test(h) && !h.includes('WASM_RT_SIMD_TYPE_DEFINED')
  ? h.replace('#include "wasm-rt.h"\n', `$&#include <simde/wasm/simd128.h>\n\n#ifndef WASM_RT_SIMD_TYPE_DEFINED\n#define WASM_RT_SIMD_TYPE_DEFINED\ntypedef simde_v128_t v128;\n#endif\n`)
  : h

/** Whether a CC (possibly carrying arguments, as "zig cc") is clang: its --version says so. */
const clangs = new Map()
const isClang = cc => {
  if (!clangs.has(cc)) {
    const [bin, ...args] = cc.trim().split(/\s+/)
    clangs.set(cc, /\bclang\b/.test(spawnSync(bin, [...args, '--version'], { encoding: 'utf8' }).stdout || ''))
  }
  return clangs.get(cc)
}

/** Whether clang targets x86 under these flags: -target, --target= or -arch names the target,
 *  else the host is it. */
const targetsX86 = cflags => {
  const i = cflags.findIndex(f => f === '-target' || f === '-arch')
  const target = i >= 0 ? cflags[i + 1] : cflags.find(f => f.startsWith('--target='))?.slice(9) ?? process.arch
  return /^(x86_64|x64|amd64|i[3-6]86|ia32)/.test(target)
}

/** The LLVM options of the native lowering. Each keeps a choice jz's wasm already made, which
 *  V8 keeps too:
 *  - -min-jump-table-entries=13: jz dispatches through compare chains, which V8 runs as branches.
 *    clang folds a chain on one value into a switch, and x86 lowers 4 or more cases to one
 *    indirect jump through a table, which a branch predictor learns far worse than the branches
 *    once the dispatched stream repeats (bench/shapes: 7.9× V8's time on Zen 5). 13 is LLVM's
 *    AArch64 default (llvm/llvm-project#71166).
 *  - -x86-cmov-converter=false, on x86: jz writes a data-dependent min, max or clamp as a select,
 *    which V8 keeps a cmov. x86's cmov converter turns one on a loop-carried chain into a branch,
 *    betting it predicts; a DP's min of three does not (bench/levenshtein: 1.77× V8's time on a
 *    Zen 3). AArch64 has no such pass. */
const llvmOptions = cflags => ['-min-jump-table-entries=13', ...targetsX86(cflags) ? ['-x86-cmov-converter=false'] : []]

/** Clang flags that hand LLVM options to codegen: to the compiler, and under LTO to the linker
 *  too, which runs codegen there. wasm2native puts them before the caller's flags, which may
 *  override them. Other compilers keep their own policy. */
export const codegen = (cc, cflags, opts = llvmOptions(cflags)) => {
  if (!isClang(cc)) return []
  const lto = cflags.some(f => /^-flto(=|$)/.test(f))
  return opts.flatMap(o => ['-mllvm', o, ...lto ? [process.platform === 'darwin' ? `-Wl,-mllvm,${o}` : `-Wl,-plugin-opt=${o}`] : []])
}

/** Exception handling and tail calls: WABT 1.0.42 enables both by default and has no
 *  --enable-* flags for them; 1.0.41 and earlier need the flags. Its --help says which. */
const featureFlags = new Map()
const features = wasm2c => {
  if (!featureFlags.has(wasm2c)) {
    const help = spawnSync(wasm2c, ['--help'], { encoding: 'utf8' }).stdout || ''
    featureFlags.set(wasm2c, ['--enable-exceptions', '--enable-tail-call'].filter(f => help.includes(f)))
  }
  return featureFlags.get(wasm2c)
}

/**
 * Translate a `--host wasi` module with wasm2c and link it with wasi.c.
 * @param {string} wasm  module path
 * @param {string} out   executable path
 * @param {object} o
 * @param {string} o.dir  scratch directory for the generated jz.c/jz.h
 * @param {string[]} [o.cflags]  compiler flags, replacing the default -O3 -ffp-contract=off
 * @param {string|null} [o.postprocess]  awk program applied to the generated C of a module that
 *   defines its memory (POSTPROCESS by default; null for none)
 * @param {boolean} [o.main]  call the exported `main` after `_initialize`/`_start`
 * @param {object} [o.tools]  toolchain() result
 */
export function wasm2native(wasm, out, { dir, cflags = CFLAGS, postprocess = POSTPROCESS, main = false, tools = toolchain() }) {
  if (tools.error) throw Error(tools.error)
  const mod = new WebAssembly.Module(readFileSync(wasm))
  const imports = WebAssembly.Module.imports(mod)
  const exports = new Set(WebAssembly.Module.exports(mod).map(e => e.name))
  const foreign = imports.filter(i => i.module !== 'wasi_snapshot_preview1' || !PROVIDED.includes(i.name))
  if (foreign.length) throw Error(`${wasm} imports ${foreign.map(i => `${i.module}.${i.name}`).join(', ')}, which a native binary cannot provide: compile with --host wasi`)
  if (imports.length && !exports.has('memory')) throw Error(`${wasm} imports WASI but exports no memory`)
  const defines = [imports.length && 'WASI', exports.has('_initialize') && 'INITIALIZE', exports.has('_start') && 'START', main && 'MAIN']
    .filter(Boolean).map(d => `-DJZ_${d}`)
  mkdirSync(dir, { recursive: true })
  const c = join(dir, 'jz.c')
  run(tools.wasm2c, [...features(tools.wasm2c), '-n', 'jz', wasm, '-o', c])
  const h = join(dir, 'jz.h'), header = readFileSync(h, 'utf8'), declared = declareV128(header)
  if (declared !== header) writeFileSync(h, declared)
  const ownMemory = exports.has('memory') && !imports.some(i => i.kind === 'memory')
  if (postprocess && ownMemory) writeFileSync(c, execFileSync('awk', ['-f', postprocess, c], { maxBuffer: 1 << 30 }))
  // CC may carry its own arguments: CC="zig cc".
  const [cc, ...ccArgs] = tools.cc.trim().split(/\s+/)
  try {
    run(cc, [...ccArgs, ...codegen(tools.cc, cflags), ...cflags, ...sysroot(), ...defines, ...[dir, ...tools.include].map(p => `-I${p}`),
      SHIM, c, ...RUNTIME.map(f => join(tools.runtime, f)), '-lm', '-o', out])
  } catch (e) {
    // WABT 1.0.39-1.0.41 emit invalid C for a tail call that passes several values.
    // Every import gets a tail-call entry; only the module's own functions show a tail call.
    if (readFileSync(c, 'utf8').includes('wasm_tailcall_w2c_jz_'))
      e.message += '\nThe module makes tail calls, which wasm2c mistranslates in some shapes: build it with --no-tail-call, or give this script the .js source.'
    throw e
  }
}

// jz options that take a value, so the value is not mistaken for the input.
const VALUED = new Set(['-O', '-D', '--define', '--memory'])
const USAGE = 'usage: node scripts/native/compile.mjs <program.js | program.wasm> [-o out] [jz options]'

function cli(args) {
  let input, out
  const jz = []
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (a === '-h' || a === '--help') return console.log(USAGE)
    if (a === '--host') throw Error('a native executable is built from --host wasi; drop --host')
    if (a === '-o' || a === '--output') out = args[++i]
    else if (VALUED.has(a)) jz.push(a, args[++i])
    else if (!input && !a.startsWith('-')) input = a
    else jz.push(a)
  }
  if (!input) throw Error(USAGE)
  const isWasm = input.endsWith('.wasm')
  if (isWasm && jz.length) throw Error(`jz options (${jz.join(' ')}) apply to a .js input, not ${input}`)
  out ??= input.replace(/\.[cm]?js$|\.wasm$/, '')
  if (resolve(out) === resolve(input)) throw Error(`name the executable with -o: it would overwrite ${input}`)
  const tools = toolchain()
  if (tools.error) throw Error(tools.error)

  const dir = mkdtempSync(join(tmpdir(), 'jz-native-'))
  const drop = () => rmSync(dir, { recursive: true, force: true })
  let wasm = input
  try {
    if (!isWasm) {
      wasm = join(dir, 'jz.wasm')
      // wasm2c mistranslates return_call with multi-value results: plain calls instead. And
      // WABT 1.0.39's reads no relaxed SIMD, 1.0.41's no f64x2.relaxed_min: standard SIMD only.
      const r = spawnSync(process.execPath, [CLI, input, ...jz, '--host', 'wasi', '--no-tail-call', '--no-relaxed-simd', '-o', wasm], { stdio: ['ignore', 'ignore', 'inherit'] })
      if (r.status !== 0) { drop(); process.exit(r.status || 1) }
    }
    wasm2native(wasm, out, { dir, cflags: [...CFLAGS, ...(process.env.CFLAGS?.split(/\s+/).filter(Boolean) ?? [])], tools })
  } catch (e) {
    // Keep the generated C when translation or compilation failed on it.
    if (existsSync(join(dir, 'jz.c'))) e.message += `\n(intermediate files kept in ${dir})`
    else drop()
    throw e
  }
  drop()
  console.log(`${input} → ${out} (${statSync(out).size} bytes)`)
}

if (process.argv[1] && real(resolve(process.argv[1])) === real(fileURLToPath(import.meta.url))) {
  try { cli(process.argv.slice(2)) } catch (e) {
    console.error(e.message)
    process.exit(1)
  }
}
