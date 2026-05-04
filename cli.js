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
jz - min JS → WASM compiler

Usage:
  jz <file.js>              Compile JS to WASM (auto-jzify)
  jz --strict <file.js>     Strict mode (no auto-transform)
  jz --jzify <file.js>      Transform JS → jz (auto-derives output file)
  jz -e <expression>        Evaluate expression
  jz --help                 Show this help

Examples:
  jz program.js                    # → program.wasm
  jz program.js --wat              # → program.wat
  jz program.js -o out.wasm        # custom output name
  jz program.js -o -               # write to stdout
  jz --strict program.js           # strict mode
  jz --jzify lib.js                # → lib.jz
  jz -e "1 + 2"

Options:
  --output, -o <file>       Output file (.wat, .wasm, or - for stdout)
  --strict                  Strict jz mode (no auto-transform)
  --jzify                   Transform JS to jz (no compilation)
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
    const jzifyIdx = args.indexOf('--jzify')
    if (jzifyIdx !== -1) await handleJzify(args.slice(jzifyIdx + 1))
    else if (evalIdx !== -1) await handleEvaluate(args.slice(evalIdx + 1))
    else await handleCompile(args)
  } catch (error) {
    console.error(error)
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
  let inputFile = null, outputFile = null
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--output' || args[i] === '-o') outputFile = args[++i]
    else if (!inputFile) inputFile = args[i]
  }
  if (!inputFile) throw new Error('No input file specified')
  if (!outputFile) outputFile = inputFile.replace(/\.js$/, '.jz')
  const code = readFileSync(inputFile, 'utf8')
  const ast = parse(code)
  const transformed = jzifyFn(ast)
  const out = codegen(transformed) + '\n'
  if (outputFile === '-') {
    process.stdout.write(out)
  } else {
    writeFileSync(outputFile, out)
    console.log(`${inputFile} → ${outputFile} (${out.length} chars)`)
  }
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

  // Recursively resolve relative imports from entry file and all discovered modules
  const importRe = /import\s+.*?\s+from\s+['"]([^'"]+)['"]/g
  const resolveModule = (specifier, fromDir) => {
    if (modules[specifier]) return
    if (!specifier.startsWith('./') && !specifier.startsWith('../')) return
    const full = resolve(fromDir, specifier)
    let src
    try { src = readFileSync(full, 'utf8') }
    catch { try { src = readFileSync(full + '.js', 'utf8') } catch { return } }
    modules[specifier] = src
    // Resolve this module's imports relative to its own directory
    let m; importRe.lastIndex = 0
    while ((m = importRe.exec(src)) !== null) resolveModule(m[1], dirname(full))
  }
  let m; importRe.lastIndex = 0
  while ((m = importRe.exec(code)) !== null) resolveModule(m[1], dir)

  // .jz = strict (no auto-transform), .js = auto-jzify
  // --strict forces strict for any extension
  const opts = {
    wat,
    jzify: !strict && !inputFile.endsWith('.jz'),
    ...(Object.keys(modules).length && { modules }),
  }

  const result = compile(code, opts)

  if (outputFile === '-') {
    process.stdout.write(result)
  } else if (wat) {
    writeFileSync(outputFile, result)
    console.log(`${inputFile} → ${outputFile} (${result.length} chars)`)
  } else {
    writeFileSync(outputFile, result)
    console.log(`${inputFile} → ${outputFile} (${result.byteLength} bytes)`)
  }
}

main().catch(error => {
  console.error(error)
  process.exit(1)
})
