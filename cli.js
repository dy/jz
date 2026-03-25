#!/usr/bin/env node

/**
 * JZ CLI - Command-line interface for JZ compiler
 */

import { readFileSync, writeFileSync } from 'fs'
import jz from './index.js'

function showHelp() {
  console.log(`
jz - JS subset → WASM compiler

Usage:
  jz <expression>           Evaluate expression
  jz <file.js>              Evaluate JS file
  jz compile <file.js>      Compile to WAT (default) or WASM
  jz --help                 Show this help

Examples:
  jz "1 + 2"
  jz compile program.js -o program.wat
  jz compile program.js -o program.wasm

Options:
  --output, -o <file>       Output file (.wat or .wasm)
  --wat                     Output WAT text instead of binary
  `)
}

async function main() {
  const args = process.argv.slice(2)

  if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
    showHelp()
    return
  }

  try {
    if (args[0] === 'compile') await handleCompile(args.slice(1))
    else await handleEvaluate(args)
  } catch (error) {
    console.error('Error:', error.message)
    process.exit(1)
  }
}

async function handleEvaluate(args) {
  const input = args.join(' ')
  let code

  if (args.length === 1 && (args[0].endsWith('.js') || args[0].endsWith('.jz')))
    code = readFileSync(args[0], 'utf8')
  else
    code = `export let _ = () => ${input}`

  const wasm = jz(code)
  const mod = new WebAssembly.Module(wasm)
  const inst = new WebAssembly.Instance(mod)

  // If there's an exported _ (expression eval), call it
  if (inst.exports._) console.log(inst.exports._())
  else console.log(inst.exports)
}

async function handleCompile(args) {
  if (args.length === 0) throw new Error('No input file specified')

  const inputFile = args[0]
  let outputFile = null
  let wat = false

  for (let i = 1; i < args.length; i++) {
    if (args[i] === '--output' || args[i] === '-o') outputFile = args[++i]
    if (args[i] === '--wat') wat = true
  }

  if (!outputFile) outputFile = inputFile.replace(/\.(js|jz)$/, wat ? '.wat' : '.wasm')
  if (outputFile.endsWith('.wat')) wat = true

  const code = readFileSync(inputFile, 'utf8')
  const result = jz(code, { wat })

  if (wat) {
    writeFileSync(outputFile, result)
    console.log(`${inputFile} → ${outputFile} (${result.length} chars)`)
  } else {
    writeFileSync(outputFile, result)
    console.log(`${inputFile} → ${outputFile} (${result.byteLength} bytes)`)
  }
}

main().catch(error => {
  console.error('Error:', error.message)
  process.exit(1)
})
