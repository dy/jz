#!/usr/bin/env node

/**
 * JZ CLI - Command-line interface for JZ compiler
 * Outputs WAT text by default, optionally compiles to WASM binary
 */

import { readFileSync, writeFileSync } from 'fs'
import { compile, instantiate } from './index.js'

// Optional watr for binary output
let watr
try { watr = await import('watr') } catch {}

function showHelp() {
  console.log(`
JZ - Minimal modern functional JS subset that compiles to WebAssembly

Usage:
  jz <expression>           Evaluate expression
  jz <file.js>             Evaluate JS file
  jz compile <file.js>     Compile to WAT (default) or WASM
  jz run <file.js>         Compile and run
  jz --help                Show this help

Examples:
  jz "1 + 2"                                         # 3
  jz compile program.js -o program.wat               # Creates program.wat
  jz compile program.js -o program.wasm              # Creates program.wasm (requires watr)
  jz run program.js                                  # Runs compiled program

Options:
  --output, -o <file>      Output file (.wat or .wasm)
  `)
}

async function main() {
  const args = process.argv.slice(2)

  if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
    showHelp()
    return
  }

  const command = args[0]

  try {
    switch (command) {
      case 'compile':
        await handleCompile(args.slice(1))
        break
      case 'run':
        await handleRun(args.slice(1))
        break
      default:
        await handleEvaluate(args)
    }
  } catch (error) {
    console.error('Error:', error.message)
    process.exit(1)
  }
}

async function handleEvaluate(args) {
  if (!watr) {
    throw new Error('watr package required for evaluation. Install with: npm i watr')
  }

  const input = args.join(' ')
  let code

  // Check if it's a file
  if (args.length === 1 && (args[0].endsWith('.js') || args[0].endsWith('.jz'))) {
    code = readFileSync(args[0], 'utf8')
  } else {
    code = input
  }

  const wat = compile(code)
  const wasm = watr.compile(wat)
  const instance = await instantiate(wasm)
  console.log(instance.run())
}

async function handleCompile(args) {
  if (args.length === 0) {
    throw new Error('No input file specified')
  }

  const inputFile = args[0]
  let outputFile = null

  // Parse options
  for (let i = 1; i < args.length; i++) {
    if (args[i] === '--output' || args[i] === '-o') {
      outputFile = args[++i]
    }
  }

  // Default output based on input
  if (!outputFile) {
    outputFile = inputFile.replace(/\.(js|jz)$/, '.wat')
  }

  const code = readFileSync(inputFile, 'utf8')
  const wat = compile(code)

  if (outputFile.endsWith('.wasm')) {
    if (!watr) {
      throw new Error('watr package required for WASM binary output. Install with: npm i watr')
    }
    const wasm = watr.compile(wat)
    writeFileSync(outputFile, wasm)
    console.log(`Compiled ${inputFile} → ${outputFile} (${wasm.byteLength} bytes)`)
  } else {
    writeFileSync(outputFile, wat)
    console.log(`Compiled ${inputFile} → ${outputFile} (${wat.length} chars)`)
  }
}

async function handleRun(args) {
  if (!watr) {
    throw new Error('watr package required for running. Install with: npm i watr')
  }

  if (args.length === 0) {
    throw new Error('No input file specified')
  }

  const inputFile = args[0]
  const code = readFileSync(inputFile, 'utf8')
  const wat = compile(code)
  const wasm = watr.compile(wat)
  const instance = await instantiate(wasm)
  console.log(instance.run())
}

// Handle uncaught errors
process.on('uncaughtException', (error) => {
  console.error('Uncaught error:', error.message)
  process.exit(1)
})

process.on('unhandledRejection', (reason) => {
  console.error('Unhandled rejection:', reason)
  process.exit(1)
})

// Run CLI
main().catch(error => {
  console.error('Error:', error.message)
  process.exit(1)
})
