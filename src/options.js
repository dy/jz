/**
 * The compile options. `normalizeOptions` holds a caller to the public contract
 * (index.d.ts CompileOptions): every key and value is checked before the
 * pipeline runs, so an option error names the option, never a source line, and
 * is never taken for a compiler bug. It then folds the result as `foldOptions`
 * does. `foldOptions` alone is the internal entry's (compiler.js
 * compileInternal): the `memory` and `optimize` objects onto the flags the
 * pipeline reads, beside the internal flags the CLI, the tests, the bench and
 * the tools pass (CONTRIBUTING.md, Public contract and ABI).
 *
 * @module options
 */
import { serialize } from './source-literal.js'
import { sourceMapOptions } from './source-map.js'
import { validateMemory } from './session.js'
import { nearest } from './optimize/config.js'
import { idStart, idPart } from './unicode.js'
import { reservedWord } from './early-errors.js'

const fail = (message) => { throw new TypeError(message) }
const plain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v) && !(v instanceof WebAssembly.Memory)
const shown = (v) => typeof v === 'string' ? `'${v}'` : typeof v === 'bigint' ? `${v}n` : typeof v === 'function' ? 'a function'
  : Array.isArray(v) ? 'an array' : v === null ? 'null' : typeof v === 'object' ? 'an object' : String(v)
const bool = (key) => (v) => typeof v === 'boolean' || fail(`${key} takes true or false; got ${shown(v)}`)

// The page counts the memory limits take; validateMemory (session.js) holds the flags to the same.
const pages = (key, min) => (v) => {
  if (typeof v !== 'number') fail(`${key} takes a ${min ? 'positive' : 'non-negative'} integer page count no greater than 65536 (each page is 64 KiB); got ${shown(v)}`)
  if (!Number.isInteger(v) || v < min || v > 65536) throw new RangeError(`${key} takes a ${min ? 'positive' : 'non-negative'} integer page count no greater than 65536 (each page is 64 KiB); got ${v}`)
}

const LEVELS = [true, false, 'size', 'speed']
// The 0.9 levels with a public spelling
const LEVEL_OF = { 0: false, 2: true, 3: 'speed' }
const level = (key) => (v) => LEVELS.includes(v) ||
  fail(`${key} takes true, false, 'size' or 'speed'; got ${shown(v)}${v in LEVEL_OF ? `: use ${shown(LEVEL_OF[v])}` : ''}`)

const MEMORY = {
  initial: pages('memory.initial', 0),
  maximum: pages('memory.maximum', 1),
  shared: bool('memory.shared'),
  import: bool('memory.import'),
  fixed: (v) => Array.isArray(v) && v.every(s => typeof s === 'string') || fail(`memory.fixed takes an array of export names; got ${shown(v)}`),
}

const OPTIMIZE = {
  level: level('optimize.level'),
  simd: bool('optimize.simd'),
  tailCall: bool('optimize.tailCall'),
  exceptions: bool('optimize.exceptions'),
  alloc: bool('optimize.alloc'),
  compact: bool('optimize.compact'),
  rationalConst: bool('optimize.rationalConst'),
}

const OPTIONS = {
  modules: (v) => plain(v) && Object.values(v).every(s => typeof s === 'string') || fail('modules takes { specifier: source }, each source a string'),
  imports: (v) => plain(v) && Object.values(v).every(m => m !== null && (typeof m === 'object' || typeof m === 'function')) ||
    fail('imports takes { module: namespace }, each namespace an object of functions and constants'),
  define: (v) => plain(v) || fail(`define takes { NAME: value }; got ${shown(v)}`),
  host: (v) => v === 'js' || v === 'wasi' || fail(`host takes 'js' or 'wasi'; got ${shown(v)}`),
  memory: (v) => {
    if (typeof v === 'number') return pages('memory', 0)(v)
    if (v instanceof WebAssembly.Memory) return
    if (!plain(v)) fail(`memory takes a non-negative integer page count, a WebAssembly.Memory or jz.memory(), or { ${Object.keys(MEMORY).join(', ')} }; got ${shown(v)}`)
    check(v, MEMORY, 'memory option', 'memory takes')
    if (v.initial != null && v.maximum != null && v.maximum < v.initial)
      throw new RangeError(`memory.maximum (${v.maximum}) is below the initial memory size (${v.initial} pages)`)
  },
  optimize: (v) => plain(v) ? check(v, OPTIMIZE, 'optimize option', 'optimize takes', RENAMED_OPTIMIZE) : level('optimize')(v),
  randomSeed: (v) => typeof v === 'number' && Number.isFinite(v) ||
    fail(`randomSeed takes a finite number, the seed of a reproducible Math.random (without it Math.random seeds from host entropy); got ${shown(v)}`),
  names: bool('names'),
  sourceMap: (v) => { if (v !== false) sourceMapOptions(v, false) },
  wat: bool('wat'),
  warnings: (v) => typeof v === 'function' || fail('warnings takes a callback, (warning) => …'),
  why: bool('why'),
}

// The 0.9 spellings, by what replaced them
const RENAMED = {
  maxMemory: 'memory: { maximum }', importMemory: 'memory: { import: true }', sharedMemory: 'memory: { shared: true }',
  fixedMemory: 'memory: { fixed }', noSimd: 'optimize: { simd: false }', tailCall: 'optimize: { tailCall }',
  noTailCall: 'optimize: { tailCall: false }', noEhAbort: 'optimize: { exceptions: false }', alloc: 'optimize: { alloc }',
  whyNotSimd: 'why: true with a warnings callback', whyNotRewind: 'why: true with a warnings callback',
  resolve: 'modules (the CLI reads imports from disk)',
  strict: 'a warnings callback, which reports each dynamic fallback',
}
const RENAMED_OPTIMIZE = { noSimd: 'simd: false', noTailCall: 'tailCall: false', noEhAbort: 'exceptions: false' }

// Every key of `obj` one `table` names, each value checked; a key it does not
// name throws, with its replacement or the key it most likely meant.
function check(obj, table, what, takes, renamed = RENAMED) {
  for (const k of Object.keys(obj)) {
    if (!Object.hasOwn(table, k)) {
      if (Object.hasOwn(renamed, k)) fail(`'${k}' is not ${/^[aeiou]/.test(what) ? 'an' : 'a'} ${what}: use ${renamed[k]}`)
      const near = nearest(k, Object.keys(table))
      fail(`Unknown ${what} '${k}'${near ? `; did you mean '${near}'?` : ''} (${takes} ${Object.keys(table).join(', ')})`)
    }
    if (obj[k] !== undefined) table[k](obj[k])
  }
}

/** Public options → the pipeline's flags. Throws a TypeError (RangeError for an
 *  out-of-range page count) naming the option before any compile state is touched. */
export const normalizeOptions = (opts) => {
  if (opts == null) return foldOptions({})
  if (!plain(opts)) fail(`options take an object; got ${shown(opts)}`)
  check(opts, OPTIONS, 'option', 'options are')
  if (opts.why && !opts.warnings) fail('why reports through warnings: pass a warnings callback beside it')
  return foldOptions(opts)
}

// A name `let NAME = …` can declare in a module
const bindable = (k) => {
  if (!k || reservedWord(k) || k === 'eval' || k === 'arguments') return false
  let i = 0
  for (const ch of k) { const cp = ch.codePointAt(0); if (!(i++ ? idPart(cp) : idStart(cp))) return false }
  return true
}

// A function's name as the program can spell it: an identifier, or a class's member (`P.get`)
const FN = /^[\p{ID_Start}$_][\p{ID_Continue}$\u200c\u200d]*(\.[\p{ID_Start}$_][\p{ID_Continue}$\u200c\u200d]*)?$/u

/** The warning a callback receives (index.d.ts Warning): what, where in the
 *  program's source, and in which of its functions. An advisory about a function
 *  the program does not name and the source does not place (a helper the
 *  compiler wrote) reaches no callback. */
const publicWarning = ({ code, message, fn, file, line, column }) => {
  const named = typeof fn === 'string' && FN.test(fn)
  if (fn != null && !named && line == null) return null
  return { code, message, ...(file != null && { file }), ...(line != null && { line, column }), ...(named && { fn }) }
}

/**
 * Options → the flags the pipeline reads, the caller's object untouched: the
 * `memory` and `optimize` objects fold onto flags, a warnings callback becomes the
 * session's sink, and every value the pipeline would otherwise meet mid-compile
 * is checked here. Internal flags pass through. Idempotent.
 */
export const foldOptions = (opts) => {
  if (!opts) opts = {}
  if (opts._normalized) return opts
  const o = { ...opts, _normalized: true }
  const m = o.memory
  if (plain(m)) {
    // WebAssembly.MemoryDescriptor plus `import` and the `fixed` export contract.
    if (m.initial != null) o.memory = m.initial; else delete o.memory
    if (m.maximum != null) o.maxMemory = m.maximum
    if (m.fixed != null) o.fixedMemory = m.fixed
    if (m.shared) o.sharedMemory = true
    if (m.import) o.importMemory = true
  } else if (m instanceof WebAssembly.Memory && typeof SharedArrayBuffer !== 'undefined' && m.buffer instanceof SharedArrayBuffer) {
    o.sharedMemory = true   // a shared Memory links only against the `shared` memtype
  }
  validateMemory(o)
  if (o.host != null && o.host !== 'js' && o.host !== 'wasi' && o.host !== 'native') fail(`host takes 'js' or 'wasi'; got ${shown(o.host)}`)
  if (o.sourceType != null && o.sourceType !== 'jz' && o.sourceType !== 'script' && o.sourceType !== 'module')
    fail(`sourceType takes 'jz', 'script' or 'module'; got ${shown(o.sourceType)}`)
  if (o.randomSeed !== undefined) OPTIONS.randomSeed(o.randomSeed)
  if (o.profile != null && typeof o.profile !== 'object') fail('profile takes an object sink, filled with compile-phase entries and totals')
  if (o.define != null) for (const [k, v] of Object.entries(o.define)) {
    if (!bindable(k)) fail(`define key '${k}' is not an identifier a module can declare`)
    if (serialize(v) === null) fail(`define.${k} is not a compile-time constant: use a number, boolean, string, null, undefined, or a literal array or object of them`)
  }
  const opt = o.optimize
  // a debug build: optimize absent or off (`false`, `{ level: false }`)
  if (o.sourceMap) o.sourceMap = sourceMapOptions(o.sourceMap, plain(opt) && (opt.level === false || opt.level === 0) ? false : opt)
  if (plain(opt)) {
    const { simd, tailCall, exceptions, alloc, ...passes } = opt
    // `level` takes the values `optimize` takes: false is off, true the default
    if (typeof passes.level === 'boolean') passes.level = passes.level ? 2 : 0
    if (simd === false) o.noSimd = true
    if (tailCall === false) o.noTailCall = true
    if (exceptions === false) o.noEhAbort = true
    if (alloc === false) o.alloc = false
    o.optimize = passes
  }
  // A callback receives the public warning; a sink object (the tests', the kernel
  // bridge's) every field the advisory recorded.
  if (typeof o.warnings === 'function') {
    const onWarning = o.warnings
    o.warnings = { entries: [], onWarning: (entry) => { const w = publicWarning(entry); if (w) onWarning(w) } }
  } else if (o.warnings != null && !plain(o.warnings)) fail('warnings takes a callback, (warning) => …')
  if (o.why && o.warnings) {
    o.whyNotSimd = true
    o.whyNotRewind = true
  }
  return o
}
