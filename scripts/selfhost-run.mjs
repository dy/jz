#!/usr/bin/env node
/**
 * Run a jz source program through the prebuilt self-host compiler (dist/jz.wasm).
 * The wasm does everything: source string in → wasm bytes out (parse + jzify +
 * prepare + compile + watr-encode all run in wasm).
 *
 * Usage: node scripts/selfhost-run.mjs '<source>'
 *   Build once with: node scripts/selfhost-build.mjs
 *   Set JZ_KERNEL_FALLBACK=1 to fall back to host-jz compile on failure (debug only).
 */
import { readFileSync, existsSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'
import { compile } from '../index.js'
import { instantiate } from '../interop.js'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SELF = resolve(ROOT, 'dist/jz.wasm')

const src = process.argv[2]
if (!src) {
  console.error('usage: node scripts/selfhost-run.mjs \'<source>\'')
  process.exit(2)
}

if (!existsSync(SELF)) {
  console.error('missing', SELF, '— run: node scripts/selfhost-build.mjs')
  process.exit(2)
}

const t0 = Date.now()
const self = instantiate(readFileSync(SELF), { memory: 8192 })
console.log('self-host compiler instantiated in', Date.now() - t0, 'ms')

const t1 = Date.now()
let bin
try {
  const out = self.exports.default(self.memory.String(src))
  bin = self.memory.read(out)
  if (!(bin instanceof Uint8Array)) bin = new Uint8Array(bin)
  if (!bin.length) throw new Error('self-host returned empty module')
  console.log('self-host compile', bin.length, 'bytes in', Date.now() - t1, 'ms')
} catch (e) {
  if (!process.env.JZ_KERNEL_FALLBACK) throw e
  console.error('self-host compile FAILED:', e?.stack || e)
  bin = compile(src, { optimize: false })
  console.log('host compile (self-host fallback)', bin.length, 'bytes in', Date.now() - t1, 'ms')
}

const { exports } = instantiate(bin, { memory: 4096 })
const main = exports.main ?? exports.default
if (typeof main !== 'function') {
  console.error('no main export')
  process.exit(1)
}
console.log('result:', main())
