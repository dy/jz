// Self-hosted compile target for `JZ_TEST_TARGET=jz.wasm node test/index.js`.
//
// Routes every jz.compile (and thus jz() / the named `compile`) through dist/jz.wasm
// — jz's whole pipeline (parse → jzify → prepare → compile → watr-encode) compiled to
// wasm BY jz. The wasm takes a source string and returns wasm bytes; the host only
// marshals the string in and reads the bytes out. Running the whole suite this way is
// the test matrix with the compiler being jz-compiled-by-jz: any divergence from the
// native run is a self-host bug. Subsumes the sample-based selfhost gate.
//
// The wasm owns the entire source→bytes pipeline, so host-side opts that shape
// compilation (imports, modules, optimize level, inspect, --wat) do NOT reach it —
// tests relying on those surface as failures to triage (feature gaps), distinct from
// genuine miscompiles.
import { readFileSync, existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import v8 from 'node:v8'
import vm from 'node:vm'
import { instantiate } from '../interop.js'

// Reclaim dead kernel instances. Each compile gets a FRESH 8192-page instance
// (512 MB committed, see getSelfModule below) whose Memory lives OUTSIDE the JS
// heap — thousands of dead instances add ~zero GC pressure, so a full test:wasm
// leg balloons past 20 GB RSS without a single major GC. Force a collection
// every few compiles: bounds live instances to GC_EVERY × 512 MB (~2 GB) for a
// few ms of GC each. Tunable via JZ_KERNEL_GC_EVERY (0 disables).
v8.setFlagsFromString('--expose-gc')
const gc = vm.runInNewContext('gc')
v8.setFlagsFromString('--no-expose-gc')
const GC_EVERY = process.env.JZ_KERNEL_GC_EVERY == null ? 4 : Number(process.env.JZ_KERNEL_GC_EVERY)
let compileCount = 0
const reclaim = () => { if (GC_EVERY && ++compileCount % GC_EVERY === 0) gc() }

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SELF = join(ROOT, 'dist/jz.wasm')
const BUILD = join(ROOT, 'scripts/build-dist.mjs')

// Native's optimize default for an unspecified `optimize` — level 2 (resolveOptimize(undefined)),
// overridable by JZ_TEST_OPTIMIZE the same way index.js's TEST_ENV_DEFAULTS applies it. The
// kernel doesn't pass through setupCtx, so the wat branch reconstructs the same default to keep
// optimize-dependent shape tests comparing like-for-like.
const DEFAULT_OPT = (() => {
  const v = process.env.JZ_TEST_OPTIMIZE
  if (v == null) return 2
  if (/^-?\d+$/.test(v)) return Number(v)
  if (v === 'false') return false
  return v  // 'size' | 'speed'
})()

// Cache the compiled Module (one expensive WebAssembly.Module compile), then hand a
// FRESH Instance to every compile. The wasm's in-wasm reset() leaves a little module
// state behind across compiles on a reused instance (regex capture slots re-declare →
// "Duplicate local"); a real self-host run compiles one program per instance, so a
// fresh instance per compile both models that and keeps the test:wasm signal free of
// cross-compile contamination. `instantiate` accepts a Module, so this is just a new
// Instance (fresh memory) — no recompile.
let selfModule
const getSelfModule = () => {
  if (selfModule) return selfModule
  if (!existsSync(SELF)) {
    console.log('dist/jz.wasm missing — building (npm run build)…')
    const r = spawnSync(process.execPath, [BUILD], { cwd: ROOT, stdio: 'inherit', timeout: 600_000 })
    if (r.status !== 0) throw new Error(`failed to build dist/jz.wasm (exit ${r.status})`)
  }
  selfModule = instantiate(readFileSync(SELF), { memory: 8192 }).module
  return selfModule
}

// Compile-level optimize config (matching the native default) as a kernel optJSON
// string, or 0 when optimize is explicitly off. Shared by the --wat and warnings legs.
// opts.modules → one JSON dict over the wasm ABI (self.js setupSelf reads it
// into ctx.module.importSources — the same channel native compile() uses).
const modulesJSONFor = (self, opts) =>
  opts.modules ? self.memory.String(JSON.stringify(opts.modules)) : 0

const optJSONFor = (self, opts) => {
  if (opts.optimize === false || opts.optimize === 0) return 0
  const base = opts.optimize == null ? DEFAULT_OPT : opts.optimize
  if (base === false || base === 0) return 0
  const o = (base && typeof base === 'object') ? base : { level: base === true ? 2 : base }
  return self.memory.String(JSON.stringify(o))
}

export const compileViaKernel = (code, opts = {}) => {
  // Compile-time advisories: the kernel runs the same advise passes and returns the
  // collected entries as JSON, which we splice into the caller's `warnings` sink.
  // Done on its own fresh instance, then we fall through to produce the bytes/WAT
  // (jz() compiles AND instantiates while reading advisories off the result).
  if (opts.warnings) {
    const w = instantiate(getSelfModule(), { memory: 8192 })
    const entries = JSON.parse(w.memory.read(w.exports.compileWarnings(w.memory.String(code), opts.strict ? 1 : 0, optJSONFor(w, opts), modulesJSONFor(w, opts))))
    opts.warnings.entries ||= []
    opts.warnings.entries.push(...entries)
  }
  const self = instantiate(getSelfModule(), { memory: 8192 })
  // `--wat` IS supported on this leg via the wasm's `compileWat` export: same
  // source→compileAst(prepare(ast)) pipeline, but watr/print of the WAT IR instead of
  // byte encoding. White-box `compile(src,{wat:true}).match(...)` codegen-shape tests
  // then validate self-host codegen (it emits the same WAT IR as native).
  if (opts.wat) {
    // Forward an optimize config so the self-host runs the same COMPILE-level passes
    // (SIMD lift, int-array promotion, narrowing, unroll, SROA) native does and emits the
    // same shapes. An UNSPECIFIED optimize mirrors the native default — level 2
    // (resolveOptimize(undefined), as TEST_ENV_DEFAULTS / JZ_TEST_OPTIMIZE applies it) —
    // not optimize:false, else every level-2 shape test compares native-level-2 codegen
    // against kernel-level-0 and diverges. The config (watr included) is forwarded
    // verbatim: self.js's compileWat now runs the full index.js optimization tail
    // (watOptimize + the optimizeFunc 'post' pass), so the self-host emits the same
    // WAT IR native does. Explicit optimize:false / 0 stays off.
    const wat = self.memory.read(self.exports.compileWat(self.memory.String(code), opts.strict ? 1 : 0, optJSONFor(self, opts), modulesJSONFor(self, opts)))
    reclaim()
    return wat
  }
  // The wasm parses + lowers internally; `strict` skips jzify (rejecting full-JS
  // syntax) to match the native compiler's accept/reject behavior. The optimize
  // config travels the same optJSON channel as the wat/warnings legs — the
  // BYTES leg mirrors native's optimize default (level 2). It was pinned to the
  // kernel's historical optimize:false while the in-kernel L2 divergences were
  // triaged; the ratchet hit ZERO (full suite green at JZ_TEST_OPTIMIZE=2
  // through dist/jz.wasm — i64 VALUE CONTRACT, untyped-receiver number
  // methods, static-literal aliasing, both-worlds i64 folders), so the kernel
  // now runs its own optimizer by default, same as native.
  const out = self.exports.default(self.memory.String(code), opts.strict ? 1 : 0, optJSONFor(self, opts), modulesJSONFor(self, opts))
  const bin = self.memory.read(out)
  // COPY out of the instance: memory.read returns a zero-copy VIEW into the wasm
  // memory (interop.js typed-array marshal), so returning it as-is pins the whole
  // 512 MB instance for as long as the caller holds the bytes — the reclaim gc
  // could never free anything. slice() detaches the result onto its own buffer.
  const bytes = (bin instanceof Uint8Array ? bin : new Uint8Array(bin)).slice()
  reclaim()
  return bytes
}
