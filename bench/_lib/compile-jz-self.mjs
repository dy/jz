#!/usr/bin/env node
// Isolated compiler-benchmark build, using the same graph and ABI as every row:
// one artifact per process, `speed` the timed build, `size` the size column's.
import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { compileJzAt } from './compile.js'

const [, , level, out] = process.argv
if (level !== 'speed' && level !== 'size' || !out) {
  console.error('usage: compile-jz-self.mjs <speed|size> <out.wasm>')
  process.exit(2)
}

const c = { id: 'jz', js: fileURLToPath(new URL('../jz/jz.js', import.meta.url)) }
writeFileSync(out, compileJzAt(c, { level, ...(level === 'speed' && process.env.JZ_SIMD ? { vectorizeLaneLocal: true } : {}) }))
