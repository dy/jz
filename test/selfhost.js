/**
 * Self-host CI gate: build jz.wasm kernel and verify it compiles sample programs.
 * Run: node test/selfhost.js
 * CI: npm run test:selfhost
 */
import test from 'tst'
import { ok } from 'tst/assert.js'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { readFileSync, existsSync } from 'node:fs'
import jz, { compileBundle } from '../index.js'
import { resolveModuleGraph } from '../src/resolve.js'
import watrCompile from 'watr/compile'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const BUILD = join(ROOT, 'scripts/selfhost-build.mjs')
const KERNEL = join(ROOT, 'dist/jz-kernel.wasm')

const run = (script, args = [], env = {}) => {
  const r = spawnSync(process.execPath, [script, ...args], {
    cwd: ROOT,
    env: { ...process.env, ...env },
    encoding: 'utf8',
    timeout: 600_000,
  })
  return r
}

test('selfhost: build jz-kernel.wasm', () => {
  const r = run(BUILD)
  if (r.status !== 0) {
    console.log(r.stdout)
    console.log(r.stderr)
  }
  ok(r.status === 0, `build exit ${r.status}`)
  ok(r.stdout.includes('jz-kernel.wasm'), 'kernel artifact written')
})

test('selfhost: kernel compiles sample without host fallback', () => {
  if (!existsSync(KERNEL)) {
    const r = run(BUILD)
    ok(r.status === 0, 'kernel build required')
  }
  readFileSync(KERNEL)
  const g = resolveModuleGraph(join(ROOT, 'src/compile/index.js'), { resolveNode: true })
  const kernel = jz(g.code, { jzify: true, modules: g.modules, memory: 8192, optimize: false, selfHost: true })
  const sample = 'export let main = () => 3 + 4'
  const bundle = compileBundle(sample, { jzify: true, optimize: false })
  const mod = kernel.exports.default(bundle.ast, bundle)
  ok(Array.isArray(mod) && mod[0] === 'module' && mod.length > 1, 'kernel compile → module IR')
  ok(watrCompile(mod).byteLength > 10, 'kernel compile → wasm bytes')
}, { timeout: 600_000 })
