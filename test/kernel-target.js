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
  // then validate self-host codegen (it emits the same WAT IR as native). No watr-level
  // WAT optimization runs, matching native `compile({wat:true, optimize:false})`.
  if (opts.wat) return self.memory.read(self.exports.compileWat(self.memory.String(code), opts.strict ? 1 : 0))
  // The wasm parses + lowers internally; `strict` skips jzify (rejecting full-JS
  // syntax) to match the native compiler's accept/reject behavior.
  const out = self.exports.default(self.memory.String(code), opts.strict ? 1 : 0)
  const bin = self.memory.read(out)
  return bin instanceof Uint8Array ? bin : new Uint8Array(bin)
}
