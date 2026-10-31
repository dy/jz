#!/usr/bin/env node

/** jz CLI — compile a JavaScript file to WebAssembly. */

import { writeFileSync, mkdirSync } from 'fs'
import { resolve, dirname, basename, relative, isAbsolute } from 'path'
import { pathToFileURL } from 'url'
import { createRequire } from 'module'
import { compileInternal } from './src/compiler.js'
import { normalizeOptions } from './src/options.js'
import { resolveModuleGraph } from './src/resolve.js'
import jzify from './jzify/index.js'

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
  -O0 | -O2 | -O3 | -Os     Optimization: none, balanced (the default), speed, size
  -O <json>                 Optimize object, e.g. -O '{"level":"speed","simd":false}'
  -D, --define <K=V>        Compile-time constant (JSON value or string); repeatable
  --host <js|wasi>          Runtime services (default js)
  --memory <n[:max]>        Initial and maximum memory, in 64 KiB pages
  --no-simd                 No auto-vectorization, for engines without SIMD
  --no-tail-call            No return_call, for engines without tail calls
  --names                   Emit the wasm name section for profilers
  --source-map              Emit a debug build and adjacent .wasm.map
  --why                     Report loops and arenas the optimizer declined
  --wat                     Emit WAT text instead of binary
  -v, --version             Show version
  -h, --help                Show this help
`

// `jz src.js -o dist/out.wasm` creates dist/ like every other compiler does.
const writeOut = (file, data) => { mkdirSync(dirname(resolve(file)), { recursive: true }); writeFileSync(file, data) }

// A warning as compilers print one: file:line:col: warning[code]: message
const formatWarning = (w, entry) => {
  const file = w.file == null ? entry : isAbsolute(w.file) ? relative(process.cwd(), w.file) : w.file
  return `${[file, w.line, w.column].filter(p => p != null).join(':')}: warning[${w.code}]: ${w.message}`
}

// -O0 none · -O2 balanced (the default) · -O3 speed · -Os size; -O '{…}' the optimize object
const OPT_LEVELS = { 0: false, 2: true, 3: 'speed', s: 'size' }
function parseLevel(v) {
  if (!Object.hasOwn(OPT_LEVELS, v)) throw new Error(`unknown optimization level '-O${v}' — use -O0, -O2, -O3, -Os or -O '{…}'`)
  return OPT_LEVELS[v]
}
function parseOptimize(v) {
  if (!v.trimStart().startsWith('{')) throw new Error(`-O takes an optimize object, -O '{…}' (got '${v}'); the levels are -O0, -O2, -O3, -Os`)
  try { return JSON.parse(v) } catch (e) { throw new Error(`-O takes an optimize object in JSON: ${e.message}`) }
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

  let inputFile = null, outputFile = null, wat = false, why = false, sourceMap = false
  let optimize, host, memory, define, names = false, noSimd = false, noTailCall = false
  // a flag's value: the next argument, which is no flag (`-` alone is stdout)
  const value = (i, flag) => {
    const v = args[i]
    if (v == null || v.startsWith('-') && v !== '-') throw new Error(`${flag} takes a value (jz --help for options)`)
    return v
  }
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (a === '--output' || a === '-o') outputFile = value(++i, a)
    else if (a === '--wat') wat = true
    else if (a === '--why') why = true
    else if (a === '--names') names = true
    else if (a === '--source-map') sourceMap = true
    else if (a === '--no-simd') noSimd = true
    else if (a === '--no-tail-call') noTailCall = true
    else if (a === '--host') host = value(++i, a)
    else if (a === '--memory') memory = parseMemory(value(++i, a))
    else if (a === '--define' || a === '-D') { const [k, v] = parseDefine(value(++i, a)); (define ||= {})[k] = v }
    else if (a.startsWith('-D') && a.length > 2) { const [k, v] = parseDefine(a.slice(2)); (define ||= {})[k] = v }
    else if (a === '-O') optimize = parseOptimize(value(++i, a))
    else if (/^-O.+/.test(a)) optimize = parseLevel(a.slice(2))
    else if (a.startsWith('-') && a !== '-') throw new Error(`unknown option '${a}' (jz --help for options)`)
    else if (!inputFile) inputFile = a
    else throw new Error(`unexpected argument '${a}' — jz compiles one entry file`)
  }
  if (!inputFile) throw new Error('No input file specified — usage: jz <file.js> (jz --help for options)')
  if (!outputFile) outputFile = inputFile.replace(/\.[cm]?js$/, '') + (wat ? '.wat' : '.wasm')
  if (outputFile.endsWith('.wat')) wat = true
  else if (wat && outputFile.endsWith('.wasm')) throw new Error(`--wat writes text: name the output .wat, not ${outputFile}`)
  if (sourceMap && (wat || outputFile === '-')) throw new Error('--source-map writes the map beside a .wasm file: it takes neither --wat, a .wat output nor -o -')

  // Every specifier resolves to an absolute path, so one physical file is one module
  // instance; bare specifiers go through Node resolution from the entry's directory.
  const { code, modules } = resolveModuleGraph(inputFile, { resolveNode: true })
  if (process.env.JZ_DEBUG_MODULES === '1') console.error('modules:', Object.keys(modules))

  // --no-simd and --no-tail-call are the optimize object's switches; a debug build is unoptimized
  const level = optimize ?? (sourceMap ? false : undefined)
  const switches = { ...(noSimd && { simd: false }), ...(noTailCall && { tailCall: false }) }
  const optimizeOpt = !Object.keys(switches).length ? level
    : { ...(typeof level === 'object' ? level : level !== undefined && { level }), ...switches }
  // The options are the public ones; the entry's URL, for import.meta.url, is the CLI's own flag.
  const flags = normalizeOptions({
    wat, why, names, warnings: w => console.warn(formatWarning(w, inputFile)),
    ...(sourceMap && { sourceMap: { source: pathToFileURL(resolve(inputFile)).href, ...(outputFile !== '-' && !wat && { url: basename(outputFile) + '.map' }) } }),
    ...(optimizeOpt !== undefined && { optimize: optimizeOpt }),
    ...(host && { host }),
    ...(memory !== undefined && { memory }),
    ...(define && { define }),
    ...(Object.keys(modules).length && { modules }),
  })
  const result = compileInternal(code, { ...flags, importMetaUrl: pathToFileURL(resolve(inputFile)).href }, jzify)

  if (outputFile === '-') process.stdout.write(result)
  else {
    writeOut(outputFile, result)
    if (result.sourceMap) writeOut(outputFile + '.map', JSON.stringify(result.sourceMap))
    console.log(`${inputFile} → ${outputFile} (${wat ? result.length + ' chars' : result.byteLength + ' bytes'})`)
  }
}

try { main() } catch (error) {
  console.error(error?.message ?? error)
  process.exit(1)
}
