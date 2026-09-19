#!/usr/bin/env node

/** jz CLI — compile a JavaScript file to WebAssembly. */

import { readFileSync, writeFileSync, mkdirSync } from 'fs'
import { resolve, dirname } from 'path'
import { pathToFileURL } from 'url'
import { createRequire } from 'module'
import { compile } from './index.js'
import { resolveModuleGraph } from './src/resolve.js'

const PKG = createRequire(import.meta.url)('./package.json')

const HELP = `
jz v${PKG.version} — JS → WASM compiler

Usage:
  jz <file.js> [options]

Examples:
  jz kernel.js                  # → kernel.wasm
  jz kernel.js --wat            # → kernel.wat
  jz kernel.js -o out.wasm      # custom output (- for stdout)
  jz kernel.js -O3              # fastest code (-Os smallest, -O0 none)
  jz kernel.js --host wasi      # standalone WASI module
  jz kernel.js --why            # report what the optimizer declined

Options:
  -o, --output <file>       Output path: .wasm, .wat, or - for stdout
  -O0 | -O3 | -Os           Optimization: none, speed, size (default: balanced)
  -O <json>                 Optimize object, e.g. -O '{"simd":false}'
  -D, --define <K=V>        Compile-time constant (JSON value or string); repeatable
  --host <js|wasi|native>   Runtime services (default js)
  --memory <n[:max]>        Initial and maximum memory, in 64 KiB pages
  --no-simd                 No auto-vectorization, for engines without SIMD
  --no-tail-call            No return_call, for engines without tail calls
  --names                   Emit the wasm name section for profilers
  --why                     Report loops and arenas the optimizer declined
  --wat                     Emit WAT text instead of binary
  -v, --version             Show version
  -h, --help                Show this help
`

// `jz src.js -o dist/out.wasm` creates dist/ like every other compiler does.
const writeOut = (file, data) => { mkdirSync(dirname(resolve(file)), { recursive: true }); writeFileSync(file, data) }

const formatWarning = w => `warning[${w.code}]${w.line != null ? ` (${w.line}:${w.column})` : ''}: ${w.message}`

// -O0 none · -O3 speed · -Os size · -O2 default · -O '{…}' advanced object
const OPT_LEVELS = { 0: false, 2: true, 3: 'speed', s: 'size', size: 'size', speed: 'speed' }
function parseOptimize(v) {
  if (v == null) throw new Error('-O expects a level (0, 2, 3, s) or an optimize object')
  if (v.trimStart().startsWith('{')) return JSON.parse(v)
  if (!(v in OPT_LEVELS)) throw new Error(`unknown optimization level '${v}' — use -O0, -O2, -O3, -Os or -O '{…}'`)
  return OPT_LEVELS[v]
}

// -D NAME=VALUE: VALUE parses as JSON when it can (numbers, booleans, null,
// arrays, objects), otherwise it is a bare string.
function parseDefine(s) {
  const eq = s.indexOf('=')
  if (eq === -1) throw new Error(`--define expects NAME=VALUE (got '${s}')`)
  let value
  try { value = JSON.parse(s.slice(eq + 1)) } catch { value = s.slice(eq + 1) }
  return [s.slice(0, eq), value]
}

// --memory 16 · --memory 16:256 (initial:maximum pages)
function parseMemory(v) {
  const pages = (part) => {
    const n = parseInt(part, 10)
    if (!Number.isInteger(n) || n < 1) throw new Error(`--memory expects positive page counts (64 KiB/page), got '${v}'`)
    return n
  }
  const [initial, maximum] = String(v).split(':')
  return maximum == null ? pages(initial) : { initial: pages(initial), maximum: pages(maximum) }
}

function main() {
  const args = process.argv.slice(2)
  if (args.includes('--version') || args.includes('-v')) return console.log(PKG.version)
  if (args.length === 0 || args.includes('--help') || args.includes('-h')) return console.log(HELP)

  let inputFile = null, outputFile = null, wat = false, why = false
  let optimize, host, memory, define, names = false, noSimd = false, noTailCall = false
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (a === '--output' || a === '-o') outputFile = args[++i]
    else if (a === '--wat') wat = true
    else if (a === '--why') why = true
    else if (a === '--names') names = true
    else if (a === '--no-simd') noSimd = true
    else if (a === '--no-tail-call') noTailCall = true
    else if (a === '--host') host = args[++i]
    else if (a === '--memory') memory = parseMemory(args[++i])
    else if (a === '--define' || a === '-D') { const [k, v] = parseDefine(args[++i]); (define ||= {})[k] = v }
    else if (a.startsWith('-D') && a.length > 2) { const [k, v] = parseDefine(a.slice(2)); (define ||= {})[k] = v }
    else if (a === '--optimize' || a === '-O') optimize = parseOptimize(args[++i])
    else if (/^-O.+/.test(a)) optimize = parseOptimize(a.slice(2))
    else if (a.startsWith('-') && a !== '-') throw new Error(`unknown option '${a}' (jz --help for options)`)
    else if (!inputFile) inputFile = a
    else throw new Error(`unexpected argument '${a}' — jz compiles one entry file`)
  }
  if (!inputFile) throw new Error('No input file specified — usage: jz <file.js> (jz --help for options)')
  if (!outputFile) outputFile = inputFile.replace(/\.[cm]?js$/, '') + (wat ? '.wat' : '.wasm')
  if (outputFile.endsWith('.wat')) wat = true

  // Every specifier resolves to an absolute path, so one physical file is one module
  // instance; bare specifiers go through Node resolution from the entry's directory.
  const { code, modules } = resolveModuleGraph(inputFile, { resolveNode: true })
  if (process.env.JZ_DEBUG_MODULES === '1') console.error('modules:', Object.keys(modules))

  const warnings = { entries: [] }
  const result = compile(code, {
    wat, warnings, why, names,
    importMetaUrl: pathToFileURL(resolve(inputFile)).href,
    ...(optimize !== undefined && { optimize }),
    ...(host && { host }),
    ...(memory !== undefined && { memory }),
    ...(define && { define }),
    ...(noSimd && { noSimd: true }),
    ...(noTailCall && { noTailCall: true }),
    ...(Object.keys(modules).length && { modules }),
  })
  for (const w of warnings.entries) console.warn(formatWarning(w))

  if (outputFile === '-') process.stdout.write(result)
  else {
    writeOut(outputFile, result)
    console.log(`${inputFile} → ${outputFile} (${wat ? result.length + ' chars' : result.byteLength + ' bytes'})`)
  }
}

try { main() } catch (error) {
  console.error(error?.message ?? error)
  process.exit(1)
}
