#!/usr/bin/env node
// Isolated compiler-benchmark build, using the same graph and ABI as every row.
// A dash skips that artifact, allowing the size harness to request only size.
import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { compileJzAt } from './compile.js'

const [, , hostOut, sizeOut] = process.argv
if (!hostOut || !sizeOut || hostOut === '-' && sizeOut === '-') {
  console.error('usage: compile-jz-self.mjs <host.wasm out|-> <size.wasm out|->')
  process.exit(2)
}

const c = { id: 'jz', js: fileURLToPath(new URL('../jz/jz.js', import.meta.url)) }
if (hostOut !== '-') writeFileSync(hostOut, compileJzAt(c, {
  level: 'speed', ...(process.env.JZ_SIMD ? { vectorizeLaneLocal: true } : {}),
}))
if (sizeOut !== '-') writeFileSync(sizeOut, compileJzAt(c, { level: 'size' }))
