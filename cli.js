#!/usr/bin/env node

/**
 * JZ CLI - Command-line interface for JZ compiler
 */

import { readFileSync, writeFileSync, existsSync } from 'fs'
import { dirname, resolve, join } from 'path'
import jz, { compile } from './index.js'

function showHelp() {
  console.log(`
jz - JS subset → WASM compiler

Usage:
  jz <file.js>              Compile to WASM (default)
  jz <file.js> -o out.wat   Compile to WAT
  jz -e <expression>        Evaluate expression
  jz -e <file.js>           Evaluate JS file
  jz --help                 Show this help

Examples:
  jz program.js -o program.wasm
  jz program.js -o program.wat
  jz -e "1 + 2"

Options:
  --output, -o <file>       Output file (.wat or .wasm)
  --eval, -e                Evaluate expression or file
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
    const evalIdx = args.indexOf('-e') !== -1 ? args.indexOf('-e') : args.indexOf('--eval')
    if (evalIdx !== -1) await handleEvaluate(args.slice(evalIdx + 1))
    else await handleCompile(args)
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

  const { exports } = jz(code)

  // If there's an exported _ (expression eval), call it
  if (exports._) console.log(exports._())
  else console.log(exports)
}

async function handleCompile(args) {
  let inputFile = null, outputFile = null, wat = false

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--output' || args[i] === '-o') outputFile = args[++i]
    else if (args[i] === '--wat') wat = true
    else if (!inputFile) inputFile = args[i]
  }

  if (!inputFile) throw new Error('No input file specified')
  if (!outputFile) outputFile = inputFile.replace(/\.(js|jz)$/, wat ? '.wat' : '.wasm')
  if (outputFile.endsWith('.wat')) wat = true

  const code = readFileSync(inputFile, 'utf8')

  // Resolve imports: jz.json map (if present) + inline import specifiers
  const dir = dirname(resolve(inputFile))
  const modules = {}

  // Load import map from package.json "imports" field (Node/Deno convention)
  const pkgFile = join(dir, 'package.json')
  if (existsSync(pkgFile)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgFile, 'utf8'))
      if (pkg.imports) for (const [spec, path] of Object.entries(pkg.imports)) {
        const full = resolve(dir, path)
        try { modules[spec] = readFileSync(full, 'utf8') } catch {}
      }
    } catch {}
  }

  // Also resolve relative imports found in source
  const importRe = /import\s+.*?\s+from\s+['"]([^'"]+)['"]/g
  let m; while ((m = importRe.exec(code)) !== null) {
    const spec = m[1]
    if (!modules[spec] && (spec.startsWith('./') || spec.startsWith('../'))) {
      const full = resolve(dir, spec)
      try { modules[spec] = readFileSync(full, 'utf8') }
      catch { try { modules[spec] = readFileSync(full + '.js', 'utf8') } catch {} }
    }
  }

  const result = compile(code, { wat, ...(Object.keys(modules).length && { modules }) })

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
