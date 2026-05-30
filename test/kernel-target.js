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

let kernel
const getKernel = () => {
  if (kernel) return kernel
  if (!existsSync(KERNEL)) {
    console.log('dist/jz.wasm missing — building (npm run build)…')
    const r = spawnSync(process.execPath, [BUILD], { cwd: ROOT, stdio: 'inherit', timeout: 600_000 })
    if (r.status !== 0) throw new Error(`failed to build dist/jz.wasm (exit ${r.status})`)
  }
  kernel = instantiate(readFileSync(KERNEL), { memory: 8192 })
  return kernel
}

export const compileViaKernel = (code, opts = {}) => {
  const ast = normalizeBigints(parse(code))
  const ir = getKernel().exports.default(ast)
  if (!Array.isArray(ir) || ir[0] !== 'module' || ir.length < 2)
    throw new Error('kernel returned non-module IR: ' + JSON.stringify(ir)?.slice(0, 160))
  return opts.wat ? watrPrint(ir) : watrCompile(ir)
}
