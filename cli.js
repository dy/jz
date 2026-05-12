#!/usr/bin/env node

/**
 * JZ CLI - Command-line interface for JZ compiler
 */

import { readFileSync, writeFileSync, existsSync } from 'fs'
import { dirname, resolve, join } from 'path'
import { pathToFileURL } from 'url'
import { execFileSync } from 'child_process'
import { parse } from 'subscript/feature/jessie'
import jz, { compile } from './index.js'
import jzifyFn, { codegen } from './src/jzify.js'
import { createRequire } from 'module'

const jzRequire = createRequire(import.meta.url)
const PKG = jzRequire('./package.json')

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
  const resolveBareModule = (specifier, fromDir) => execFileSync(
    process.execPath,
    ['--input-type=module', '-e', 'process.stdout.write(import.meta.resolve(process.argv[1]))', specifier],
    { cwd: fromDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
  ).trim()
  const resolveModule = (specifier, fromDir) => {
    if (modules[specifier]) return
    // Relative imports: resolve from filesystem
    if (specifier.startsWith('./') || specifier.startsWith('../')) {
      const full = resolve(fromDir, specifier)
      let src
      try { src = readFileSync(full, 'utf8') }
      catch { try { src = readFileSync(full + '.js', 'utf8') } catch { return } }
      modules[specifier] = src
      let m; importRe.lastIndex = 0
      while ((m = importRe.exec(src)) !== null) resolveModule(m[1], dirname(full))
      return
    }
    // Bare specifiers: opt-in Node.js resolution
    if (resolveNode) {
      try {
        const resolved = resolveBareModule(specifier, fromDir)
        if (resolved.startsWith('file:')) modules[specifier] = readFileSync(new URL(resolved), 'utf8')
      } catch {}
    }
  }
  let m; importRe.lastIndex = 0
  while ((m = importRe.exec(code)) !== null) resolveModule(m[1], dir)

  // .jz = strict (no auto-transform), .js = auto-jzify
  // --strict forces strict for any extension
  const opts = {
    wat,
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
