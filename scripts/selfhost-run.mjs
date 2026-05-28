#!/usr/bin/env node
/**
 * Run a jz source program via the prebuilt self-host kernel.
 * Pipeline:  host parse → normalizeBigints → kernel.compileParsed → watrCompile → instantiate
 *
 * Usage: node scripts/selfhost-run.mjs '<source>'
 *   Build the kernel once with: node scripts/selfhost-build.mjs
 *   JZ_KERNEL_STRICT=1 errors instead of falling back to host jz on kernel failure.
 */
import { readFileSync, existsSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'
import { compile } from '../index.js'
import { instantiate, normalizeBigints } from '../interop.js'
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

const t0 = Date.now()
const kernel = instantiate(readFileSync(KERNEL), { memory: 8192 })
console.log('kernel instantiated in', Date.now() - t0, 'ms')

const t1 = Date.now()
let bin
try {
  // Host parses; normalize BigInt primitives (the marshalling layer cannot
  // serialize them) so kernel sees the self-describing ['bigint', dec] form.
  const ast = normalizeBigints(parse(src))
  const ir = kernel.exports.default(ast)
  if (!ir || ir.length <= 1) throw new Error('kernel returned empty module')
  bin = watrCompile(ir)
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
