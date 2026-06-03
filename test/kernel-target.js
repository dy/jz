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
import { instantiate } from '../interop.js'

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

export const compileViaKernel = (code, opts = {}) => {
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
    // against kernel-level-0 and diverges. `watr` is forced OFF: compileWat prints
    // compileAst(prepare(ast)) directly and does not run watOptimize (the watr-level CSE/
    // DCE/inline pass still infinite-loops when self-compiled on some folded-OBJECT IR,
    // e.g. `const o = JSON.parse('{"x":42}'); o.x`), and turning it off relocates the
    // deferred passes (vectorize) into compileAst's pre-phase. Explicit optimize:false / 0
    // stays off.
    let optJSON = 0
    if (opts.optimize !== false && opts.optimize !== 0) {
      const base = opts.optimize == null ? DEFAULT_OPT : opts.optimize
      if (base !== false && base !== 0) {
        const o = (base && typeof base === 'object')
          ? { ...base, watr: false }
          : { level: base === true ? 2 : base, watr: false }
        optJSON = self.memory.String(JSON.stringify(o))
      }
    }
    return self.memory.read(self.exports.compileWat(self.memory.String(code), opts.strict ? 1 : 0, optJSON))
  }
  // The wasm parses + lowers internally; `strict` skips jzify (rejecting full-JS
  // syntax) to match the native compiler's accept/reject behavior.
  const out = self.exports.default(self.memory.String(code), opts.strict ? 1 : 0)
  const bin = self.memory.read(out)
  return bin instanceof Uint8Array ? bin : new Uint8Array(bin)
}
