#!/usr/bin/env node

/**
 * JZ CLI - Command-line interface for JZ compiler
 */

import { readFileSync, writeFileSync, existsSync } from 'fs'
import { dirname, resolve, join } from 'path'
import { parse } from 'subscript/jessie'
import jz, { compile } from './index.js'
import jzifyFn, { codegen } from './src/jzify.js'

function showHelp() {
  console.log(`
jz - JS subset → WASM compiler (Crockford-aligned)

Usage:
  jz <file.jz>              Compile jz to WASM
  jz <file.js>              Auto-jzify JS, then compile to WASM
  jz --jzify <file.js>      Transform JS → jz (output to stdout)
  jz -e <expression>        Evaluate expression
  jz --help                 Show this help

Examples:
  jz program.jz -o program.wasm
  jz program.js -o program.wasm     # auto-jzify
  jz --jzify lib.js > lib.jz        # transform only
  jz -e "1 + 2"

Options:
  --output, -o <file>       Output file (.wat or .wasm)
  --jzify                   Transform JS to jz (no compilation)
  --eval, -e                Evaluate expression or file
  --wat                     Output WAT text instead of binary
  --strict                  Enforce mandatory semicolons
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
    const jzifyIdx = args.indexOf('--jzify')
    if (jzifyIdx !== -1) await handleJzify(args.slice(jzifyIdx + 1))
    else if (evalIdx !== -1) await handleEvaluate(args.slice(evalIdx + 1))
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

async function handleJzify(args) {
  const inputFile = args[0]
  if (!inputFile) throw new Error('No input file specified')
  const code = readFileSync(inputFile, 'utf8')
  const ast = parse(code)
  const transformed = jzifyFn(ast)
  process.stdout.write(codegen(transformed) + '\n')
}

async function handleCompile(args) {
  let inputFile = null, outputFile = null, wat = false, strict = false

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--output' || args[i] === '-o') outputFile = args[++i]
    else if (args[i] === '--wat') wat = true
    else if (args[i] === '--strict') strict = true
    else if (!inputFile) inputFile = args[i]
  }

  if (!inputFile) throw new Error('No input file specified')
  if (!outputFile) outputFile = inputFile.replace(/\.(js|jz)$/, wat ? '.wat' : '.wasm')
  if (outputFile.endsWith('.wat')) wat = true

  // .jz = strict jz (mandatory ;), .js = auto-jzify
  const isJs = inputFile.endsWith('.js')
  const isJz = inputFile.endsWith('.jz')
  if (isJz) strict = true

  const code = readFileSync(inputFile, 'utf8')

  // Resolve imports
  const dir = dirname(resolve(inputFile))
  const modules = {}

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

  const importRe = /import\s+.*?\s+from\s+['"]([^'"]+)['"]/g
  let m; while ((m = importRe.exec(code)) !== null) {
    const spec = m[1]
    if (!modules[spec] && (spec.startsWith('./') || spec.startsWith('../'))) {
      const full = resolve(dir, spec)
      try { modules[spec] = readFileSync(full, 'utf8') }
      catch { try { modules[spec] = readFileSync(full + '.js', 'utf8') } catch {} }
    }
  }

  const opts = {
    wat,
    ...(strict && { strict: true }),
    ...(isJs && { jzify: true }),
    ...(Object.keys(modules).length && { modules }),
  }

  const result = compile(code, opts)

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
