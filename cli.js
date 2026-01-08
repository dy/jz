#!/usr/bin/env node

/**
 * JZ CLI - Command-line interface for JZ compiler
 * Supports both WASM binary and WAT text output
 */

import { readFileSync, writeFileSync } from 'fs'
import { default as JZ } from './index.js'

function showHelp() {
  console.log(`
JZ - Minimal modern functional JS subset that compiles to WebAssembly

Usage:
  jz <expression>           Evaluate expression (WAT syntax)
  jz <file.wat>            Evaluate WAT file
  jz compile <file.wat>    Compile to WebAssembly
  jz run <file.wat>        Compile and run WAT file
  jz --help                Show this help

Examples:
  jz "(f64.add (f64.const 1) (f64.const 2))"           # 3
  jz compile program.wat --format binary              # Creates program.wasm
  jz compile program.wat --format wat                 # Creates program.wat (copy)
  jz run program.wat                                  # Runs compiled program

Options:
  --output, -o <file>      Output file for compilation
  --format, -f <format>    Output format: binary (default) or wat
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
  const input = args.join(' ')
  
  // Check if it's a file
  if (args.length === 1 && (args[0].endsWith('.wat') || args[0].endsWith('.js'))) {
    const code = readFileSync(args[0], 'utf8')
    const result = await JZ.evaluate(code)
    console.log(result)
  } else {
    // Evaluate as expression
    const result = await JZ.evaluate(input)
    console.log(result)
  }
}

async function handleCompile(args) {
  if (args.length === 0) {
    throw new Error('No input file specified')
  }

  const inputFile = args[0]
  let outputFile = 'out.wasm'
  let format = 'binary'
  
  // Parse options
  for (let i = 1; i < args.length; i++) {
    if (args[i] === '--output' || args[i] === '-o') {
      outputFile = args[++i]
    } else if (args[i] === '--format' || args[i] === '-f') {
      format = args[++i]
    }
  }

  // Set default output file based on format
  if (outputFile === 'out.wasm' && format === 'wat') {
    outputFile = 'out.wat'
  }

  const code = readFileSync(inputFile, 'utf8')
  const result = JZ.compile(code, { format })
  
  if (format === 'binary') {
    writeFileSync(outputFile, result)
    console.log(`Compiled ${inputFile} to ${outputFile} (${result.byteLength} bytes)`)
  } else {
    writeFileSync(outputFile, result)
    console.log(`Generated ${inputFile} to ${outputFile} (${result.length} chars)`)
  }
}

async function handleRun(args) {
  if (args.length === 0) {
    throw new Error('No input file specified')
  }

  const inputFile = args[0]
  const code = readFileSync(inputFile, 'utf8')
  
  const result = await JZ.evaluate(code)
  console.log(result)
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