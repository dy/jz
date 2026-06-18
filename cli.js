#!/usr/bin/env node

/**
 * JZ CLI - Command-line interface for JZ compiler
 */

import { readFileSync, writeFileSync } from 'fs'
import { resolve } from 'path'
import { pathToFileURL } from 'url'
import jz, { compile } from './index.js'
import transform from './transform.js'
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
  jz <file.js>              Compile JS to WASM (full JS subset; .jz = strict)
  jz --strict <file.js>     Strict mode — pure canonical subset, no lowering
  jz --jzify <file.js>      Transform JS → jz source (auto-derives output file)
  jz -e <expression>        Evaluate expression
  jz --help                 Show this help

Examples:
  jz program.js                    # → program.wasm
  jz program.js --wat              # → program.wat
  jz program.js -o out.wasm        # custom output name
  jz program.js -o -               # write to stdout
  jz program.js -O3                # optimize for speed
  jz program.js -Os                # optimize for size
  jz program.js -D DEBUG=false     # inject a compile-time constant
  jz program.js --memory 64        # 64 initial pages (4 MB)
  jz program.js --host wasi        # emit WASI Preview 1 imports
  jz --strict program.js           # strict mode
  jz --jzify lib.js                # → lib.jz
  jz -e "1 + 2"

Options:
  --output, -o <file>       Output file (.wat, .wasm, or - for stdout)
  -O<n>, --optimize <n>     Optimization level: 0 off, 1 minimal, 2 default (all
                            stable passes), 3 speed. -Os optimizes for size.
  --define, -D <K=V>        Inject a compile-time constant (VALUE parsed as JSON,
                            else string). Repeatable.
  --host <js|wasi>          Runtime-service lowering (default js)
  --memory <pages>          Initial memory size in 64 KiB pages
  --max-memory <pages>      Cap memory growth at this many pages (default unbounded)
  --import-memory           Import env.memory instead of exporting own memory
  --no-alloc                Omit _alloc/_clear allocator exports (standalone wasm)
  --no-simd                 Disable auto-vectorization (no v128) for non-SIMD engines
  --why-not-simd            Report, per loop, why the auto-vectorizer declined it
  --experimental-stencil    Enable neighbour-load stencil vectorization (a[i±1]; opt-in)
  --no-tail-call            Use ordinary call frames instead of return_call
  --names                   Emit wasm name section for profilers/debuggers
  --stats                   Print compile-phase timings to stderr
  --strict                  Pure canonical subset: reject full-JS syntax + dynamic fallbacks
  --jzify                   Transform JS to jz source (no compilation)
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
  const isFile = args.length === 1 && (args[0].endsWith('.js') || args[0].endsWith('.jz'))
  // A bare expression ("1 + 2") is wrapped in an arrow so its value can be printed. A file, or
  // `-e` text that is already module-level (top-level export/import), compiles as-is — wrapping it
  // would splice `export let _ = () => export …` and crash with a garbled SyntaxError.
  const isModule = isFile || /^\s*(export|import)\b/m.test(input)
  const code = isFile ? readFileSync(args[0], 'utf8')
    : isModule ? input
    : `export let _ = () => ${input}`

  const { exports } = jz(code)

  if (exports._ !== undefined) console.log(exports._())                    // expression eval → print value
  else if (typeof exports.main === 'function') console.log(exports.main()) // module with a main() entry
  else console.log(`compiled; exports: ${Object.keys(exports).join(', ') || '(none)'}`)
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
  const out = transform(code) + '\n'
  if (outputFile === '-') {
    process.stdout.write(out)
  } else {
    writeFileSync(outputFile, out)
    console.log(`${inputFile} → ${outputFile} (${out.length} chars)`)
  }
}

// -O<n> numeric levels (0–3); -Os → size preset. The 'size'/'speed' strings are
// also accepted via `--optimize <name>` for parity with the JS API (-O3 = speed).
const OPT_ALIAS = { s: 'size' }
function parseOptimize(v) {
  if (v == null) return undefined
  if (/^\d+$/.test(v)) return +v
  return OPT_ALIAS[v] ?? v
}

// -D NAME=VALUE / --define NAME=VALUE → [key, value]. VALUE is parsed as JSON when
// it can be (numbers, booleans, null, JSON arrays/objects); otherwise a bare string.
function parseDefine(s) {
  const eq = s.indexOf('=')
  if (eq === -1) throw new Error(`--define expects NAME=VALUE (got '${s}')`)
  let value
  try { value = JSON.parse(s.slice(eq + 1)) } catch { value = s.slice(eq + 1) }
  return [s.slice(0, eq), value]
}

function parsePages(v, flag) {
  const n = parseInt(v, 10)
  if (!Number.isInteger(n) || n < 1) throw new Error(`${flag} expects a positive integer page count (64 KiB/page)`)
  return n
}

// --stats: dump top-level compile-phase timings to stderr (stdout stays clean for
// `-o -`). Sub-phase (optMod:*) detail is left to the programmatic `profile` sink.
function printStats(profile) {
  const rows = Object.entries(profile.totals || {}).filter(([n]) => !n.includes(':'))
  if (!rows.length) return
  const width = Math.max(5, ...rows.map(([n]) => n.length))
  const total = rows.reduce((sum, [, ms]) => sum + ms, 0)
  console.error('compile stats (ms):')
  for (const [name, ms] of rows) console.error(`  ${name.padEnd(width)} ${ms.toFixed(2)}`)
  console.error(`  ${'total'.padEnd(width)} ${total.toFixed(2)}`)
}

async function handleCompile(args) {
  let inputFile = null, outputFile = null, wat = false, strict = false, resolveNode = false, importsFile = null
  let optimize, host, alloc = true, names = false, stats = false, noSimd = false, noTailCall = false
  let memory, maxMemory, importMemory = false, define, whyNotSimd = false, experimentalStencil = false

  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (a === '--output' || a === '-o') outputFile = args[++i]
    else if (a === '--wat') wat = true
    else if (a === '--strict') strict = true
    else if (a === '--resolve') resolveNode = true
    else if (a === '--imports') importsFile = args[++i]
    else if (a === '--define' || a === '-D') { const [k, v] = parseDefine(args[++i]); (define ||= {})[k] = v }
    else if (a.startsWith('-D') && a.length > 2) { const [k, v] = parseDefine(a.slice(2)); (define ||= {})[k] = v }
    else if (a === '--optimize' || a === '-O') optimize = parseOptimize(args[++i])
    else if (/^-O.+/.test(a)) optimize = parseOptimize(a.slice(2))
    else if (a === '--host') host = args[++i]
    else if (a === '--memory') memory = parsePages(args[++i], '--memory')
    else if (a === '--max-memory') maxMemory = parsePages(args[++i], '--max-memory')
    else if (a === '--import-memory') importMemory = true
    else if (a === '--no-alloc') alloc = false
    else if (a === '--no-simd') noSimd = true
    else if (a === '--why-not-simd') whyNotSimd = true
    else if (a === '--experimental-stencil') experimentalStencil = true
    else if (a === '--no-tail-call') noTailCall = true
    else if (a === '--names') names = true
    else if (a === '--stats') stats = true
    else if (!inputFile) inputFile = a
  }

  if (!inputFile) throw new Error('No input file specified')
  if (!outputFile) outputFile = inputFile.replace(/\.(js|jz)$/, wat ? '.wat' : '.wasm')
  if (outputFile.endsWith('.wat')) wat = true

  // Resolve imports — canonicalize every specifier to an absolute path so the
  // same physical file always produces one module instance (see src/resolve.js).
  const { code: codeRewritten, modules } = resolveModuleGraph(inputFile, { resolveNode })
  if (process.env.JZ_DEBUG_MODULES === '1') console.error('modules:', Object.keys(modules))

  // jzify is default-on; strict (pure canonical subset) is opt-in.
  // `.jz` files are treated as strict; `--strict` forces it for any extension.
  if (inputFile.endsWith('.jz')) strict = true
  const warnings = { entries: [] }
  const profile = stats ? {} : null
  const opts = {
    wat,
    warnings,
    strict,
    importMetaUrl: pathToFileURL(resolve(inputFile)).href,
    ...(optimize !== undefined && { optimize }),
    ...(host && { host }),
    ...(memory !== undefined && { memory }),
    ...(maxMemory !== undefined && { maxMemory }),
    ...(importMemory && { importMemory: true }),
    ...(alloc === false && { alloc: false }),
    ...(noSimd && { noSimd: true }),
    ...(whyNotSimd && { whyNotSimd: true }),
    ...(experimentalStencil && { experimentalStencil: true }),
    ...(noTailCall && { noTailCall: true }),
    ...(define && { define }),
    ...(names && { names: true }),
    ...(profile && { profile }),
    ...(Object.keys(modules).length && { modules }),
  }

  if (importsFile) {
    const importsPath = resolve(importsFile)
    opts.imports = JSON.parse(readFileSync(importsPath, 'utf8'))
  }

  const result = compile(codeRewritten, opts)

  for (const w of warnings.entries)
    console.warn(formatWarning(w))
  if (profile) printStats(profile)

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
