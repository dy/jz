#!/usr/bin/env node
/**
 * Run a jz test entry via the self-host kernel (host prepare → kernel compile → run).
 * Usage: node scripts/selfhost-run.mjs '<source>' [memoryPages]
 */
import { readFileSync, existsSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'
import jz, { compile } from '../index.js'
import { resolveModuleGraph } from '../src/resolve.js'
import { instantiate } from '../interop.js'
import { parse } from 'subscript/feature/jessie'
import watrCompile from 'watr/compile'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const KERNEL = resolve(ROOT, 'dist/jz-kernel.wasm')

const src = process.argv[2]
if (!src) {
  console.error('usage: node scripts/selfhost-run.mjs \'<source>\'')
  process.exit(2)
}

if (!existsSync(KERNEL)) {
  console.error('missing', KERNEL, '— run: node scripts/selfhost-build.mjs')
  process.exit(2)
}

readFileSync(KERNEL)
const g = resolveModuleGraph(resolve(ROOT, 'src/compile/kernel.js'), { resolveNode: true })
const t0 = Date.now()
const kernel = jz(g.code, { jzify: true, modules: g.modules, memory: 8192, optimize: false })
console.log('kernel loaded in', Date.now() - t0, 'ms')

// Self-host split: host parses, kernel runs jzify→prepare→compile, host runs watr backend.
const ast = parse(src)
const t1 = Date.now()
let bin
try {
  const mod = kernel.exports.default(ast)
  if (!mod || mod.length <= 1) throw new Error('empty module')
  bin = watrCompile(mod)
  console.log('kernel compile', bin.length, 'bytes in', Date.now() - t1, 'ms')
} catch (e) {
  if (process.env.JZ_KERNEL_STRICT) throw e
  console.error('kernel compile FAILED:', e?.stack || e)
  bin = compile(src, { jzify: true, optimize: false })
  console.log('host compile (kernel fallback)', bin.length, 'bytes in', Date.now() - t1, 'ms')
}

const { exports } = instantiate(bin, { memory: 4096 })
const main = exports.main ?? exports.default
if (typeof main !== 'function') {
  console.error('no main export')
  process.exit(1)
}
console.log('result:', main())
