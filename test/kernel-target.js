// Self-hosted compile target for `JZ_TEST_TARGET=jz.wasm node test/index.js`.
//
// Routes every jz.compile (and thus jz() / the named `compile`) through the jz.wasm
// KERNEL — jz's own compileParsed pipeline (jzify → prepare → compile) compiled to
// wasm BY jz. The host still parses (subscript/jessie) and runs the watr backend —
// the two pieces jz can't yet run on itself. Running the whole suite this way is the
// test matrix, but with the compiler being jz-compiled-by-jz: any divergence from the
// native run is a self-host bug. This subsumes the sample-based selfhost gate.
//
// The kernel takes a RAW parsed AST and owns reset+jzify+prepare+compile internally,
// so host-side opts that shape compilation (imports, modules, memory, optimize level,
// inspect/wat) do NOT reach it — tests relying on those surface as failures to triage
// (feature gaps), distinct from genuine miscompiles.
import { readFileSync, existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { parse } from 'subscript/feature/jessie'
import watrCompile from 'watr/compile'
import watrPrint from 'watr/print'
import { instantiate, normalizeBigints } from '../interop.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const KERNEL = join(ROOT, 'dist/jz.wasm')
const BUILD = join(ROOT, 'scripts/build-dist.mjs')

// Cache the compiled Module (one expensive WebAssembly.Module compile), then
// hand a FRESH Instance to every compile. The kernel's in-wasm reset() leaves a
// little module state behind across compiles on a reused instance (regex capture
// slots re-declare → "Duplicate local"); a real self-host run compiles one
// program per instance, so a fresh instance per compile both models that and
// keeps the test:wasm signal free of cross-compile contamination. `instantiate`
// accepts a Module, so this is just a new Instance (fresh memory) — no recompile.
let kernelModule
const getKernelModule = () => {
  if (kernelModule) return kernelModule
  if (!existsSync(KERNEL)) {
    console.log('dist/jz.wasm missing — building (npm run build)…')
    const r = spawnSync(process.execPath, [BUILD], { cwd: ROOT, stdio: 'inherit', timeout: 600_000 })
    if (r.status !== 0) throw new Error(`failed to build dist/jz.wasm (exit ${r.status})`)
  }
  kernelModule = kernelModule || instantiate(readFileSync(KERNEL), { memory: 8192 }).module
  return kernelModule
}

export const compileViaKernel = (code, opts = {}) => {
  const ast = normalizeBigints(parse(code))
  const kernel = instantiate(getKernelModule(), { memory: 8192 })
  // Mirror the host's opt-in jzify gating (index.js): only lower full-JS forms when
  // the test asked for it, so prohibited syntax (var/class/function/…) is rejected
  // by the kernel exactly as the in-process compiler rejects it.
  const ir = kernel.exports.default(ast, null, opts.jzify ? 1 : 0)
  if (!Array.isArray(ir) || ir[0] !== 'module' || ir.length < 2)
    throw new Error('kernel returned non-module IR: ' + JSON.stringify(ir)?.slice(0, 160))
  return opts.wat ? watrPrint(ir) : watrCompile(ir)
}
