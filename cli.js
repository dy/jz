#!/usr/bin/env node

/**
 * JZ CLI - Command-line interface for JZ compiler
 */

import { readFileSync, writeFileSync } from 'fs'
import { resolve } from 'path'
import { pathToFileURL } from 'url'
import { parse } from 'subscript/feature/jessie'
import jz, { compile } from './index.js'
import jzifyFn from './jzify/index.js'
import { codegen } from './src/wat/codegen.js'
import { resolveModuleGraph } from './src/resolve.js'
import { createRequire } from 'module'

const jzRequire = createRequire(import.meta.url)
const PKG = jzRequire('./package.json')

function formatWarning(w) {
  const where = w.line != null ? ` (${w.line}:${w.column})` : ''
  return `warning[${w.code}]${where}: ${w.message}`
}

function showHelp() {
  console.log(`
jz v${PKG.version} - min JS → WASM compiler

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
  jz program.js -O3                # aggressive optimization
  jz program.js -Os                # optimize for size
  jz program.js --host wasi        # emit WASI Preview 1 imports
  jz --strict program.js           # strict mode
  jz --jzify lib.js                # → lib.jz
  jz -e "1 + 2"

Options:
  --output, -o <file>       Output file (.wat, .wasm, or - for stdout)
  -O<n>, --optimize <n>     Optimization level: 0 off, 1 size-only, 2 default,
                            3 aggressive. Aliases: -Os/size, -Ob/balanced, -Of/speed.
  --host <js|wasi>          Runtime-service lowering (default js)
  --no-alloc                Omit _alloc/_clear allocator exports (standalone wasm)
  --names                   Emit wasm name section for profilers/debuggers
  --strict                  Strict jz mode (no auto-transform), reject dynamic fallbacks
  --jzify                   Transform JS to jz (no compilation)
  --eval, -e                Evaluate expression or file
  --wat                     Output WAT text instead of binary
  --resolve                 Resolve bare specifiers via Node.js module resolution
  --imports <file>          JSON file with host import specs (e.g. {"env":{"fn":{"params":2}}})
  --version, -v             Show version number
  `)
}

async function main() {
  const args = process.argv.slice(2)

  if (args.includes('--version') || args.includes('-v')) {
    console.log(PKG.version)
    return
  }

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

// -O<n>/-Os/-Ob/-Of and --optimize <val> → value accepted by compile()'s `optimize` opt
const OPT_ALIAS = { s: 'size', b: 'balanced', f: 'speed' }
function parseOptimize(v) {
  if (v == null) return undefined
  if (/^\d+$/.test(v)) return +v
  return OPT_ALIAS[v] ?? v
}

async function handleCompile(args) {
  let inputFile = null, outputFile = null, wat = false, strict = false, resolveNode = false, importsFile = null
  let optimize, host, alloc = true, names = false

  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (a === '--output' || a === '-o') outputFile = args[++i]
    else if (a === '--wat') wat = true
    else if (a === '--strict') strict = true
    else if (a === '--resolve') resolveNode = true
    else if (a === '--imports') importsFile = args[++i]
    else if (a === '--optimize' || a === '-O') optimize = parseOptimize(args[++i])
    else if (/^-O.+/.test(a)) optimize = parseOptimize(a.slice(2))
    else if (a === '--host') host = args[++i]
    else if (a === '--no-alloc') alloc = false
    else if (a === '--names') names = true
    else if (!inputFile) inputFile = a
  }

  if (!inputFile) throw new Error('No input file specified')
  if (!outputFile) outputFile = inputFile.replace(/\.(js|jz)$/, wat ? '.wat' : '.wasm')
  if (outputFile.endsWith('.wat')) wat = true

  // Resolve imports — canonicalize every specifier to an absolute path so the
  // same physical file always produces one module instance (see src/resolve.js).
  const { code: codeRewritten, modules } = resolveModuleGraph(inputFile, { resolveNode })
  if (process.env.JZ_DEBUG_MODULES === '1') console.error('modules:', Object.keys(modules))

  // .jz = strict (no auto-transform), .js = auto-jzify
  // --strict forces strict for any extension
  const warnings = { entries: [] }
  const opts = {
    wat,
    warnings,
    jzify: !strict && !inputFile.endsWith('.jz'),
    strict,
    importMetaUrl: pathToFileURL(resolve(inputFile)).href,
    ...(optimize !== undefined && { optimize }),
    ...(host && { host }),
    ...(alloc === false && { alloc: false }),
    ...(names && { profileNames: true }),
    ...(Object.keys(modules).length && { modules }),
  }

  if (importsFile) {
    const importsPath = resolve(importsFile)
    opts.imports = JSON.parse(readFileSync(importsPath, 'utf8'))
  }

  const result = compile(codeRewritten, opts)

  for (const w of warnings.entries)
    console.warn(formatWarning(w))

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
