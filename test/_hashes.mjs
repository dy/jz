// The refactor oracle widened to the whole suite. scripts/refactor-oracle.mjs
// hashes the bench and example corpus; this hashes every compile the tests make.
//
//   JZ_HASHES=<out.json> node --import ./test/_hashes.mjs test/index.js
//     records, for each in-process compile of the run, the sha256 of its output
//     (or of its error) keyed by the source and options it was given.
//     With JZ_MUTANT_EDITS set, the run is also a knockout (test/_mutant.mjs).
//   node test/_hashes.mjs <before.json> <after.json>
//     lists the keys whose outputs differ and exits 1 if any do.
//
// Test-only, in the style of test/_mutant.mjs: index.js is edited as Node loads
// it so _compileInProcess reports to the recorder; the tree on disk is untouched.
// A key compiled more than once keeps the set of its outcomes. Options are keyed
// with object keys sorted, functions by arity (what setupCtx reads of them),
// memories by size, and `profile` by presence (it collects timings).
import { register } from 'node:module'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { isMainThread } from 'node:worker_threads'

const sha = (x) => createHash('sha256').update(x).digest('hex').slice(0, 32)

const canon = (v, seen = new WeakSet()) => {
  if (typeof v === 'function') return `ƒ${v.length}`
  if (typeof v === 'bigint') return `${v}n`
  if (v === undefined) return 'undefined'
  if (v === null || typeof v !== 'object') return JSON.stringify(v)
  if (seen.has(v)) return '↺'
  seen.add(v)
  if (ArrayBuffer.isView(v)) return `bytes:${sha(v)}`
  if (v instanceof WebAssembly.Memory) return `memory:${v.buffer.byteLength}:${v.buffer instanceof SharedArrayBuffer}`
  if (v instanceof Map || v instanceof Set) return `${v.constructor.name}[${[...v].map(x => canon(x, seen)).join(',')}]`
  if (Array.isArray(v)) return `[${v.map(x => canon(x, seen)).join(',')}]`
  return `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${k === 'profile' ? '•' : canon(v[k], seen)}`).join(',')}}`
}

const outcome = (r) => r instanceof Uint8Array ? sha(r) : typeof r === 'string' ? `wat:${sha(r)}` : `obj:${sha(canon(r))}`

const compare = (beforePath, afterPath) => {
  const [a, b] = [beforePath, afterPath].map(p => JSON.parse(readFileSync(p, 'utf8')).entries)
  const changed = Object.keys(a).filter(k => k in b && a[k][1].join() !== b[k][1].join())
  const gone = Object.keys(a).filter(k => !(k in b)), added = Object.keys(b).filter(k => !(k in a))
  for (const k of changed) console.log(`changed ${k}: ${JSON.stringify(a[k][0])}\n  before ${a[k][1].join(' ')}\n  after  ${b[k][1].join(' ')}`)
  for (const [label, keys, side] of [['only before', gone, a], ['only after', added, b]])
    for (const k of keys.slice(0, 20)) console.log(`${label} ${k}: ${JSON.stringify(side[k][0])}`)
  console.log(`${Object.keys(a).length} keys before, ${Object.keys(b).length} after: ${changed.length} changed, ${gone.length} only before, ${added.length} only after`)
  process.exit(changed.length ? 1 : 0)
}

const record = (out) => {
  // Support the split compiler entry as well as checkouts predating that move.
  const split = fileURLToPath(new URL('../src/compiler.js', import.meta.url))
  const index = existsSync(split) ? split : fileURLToPath(new URL('../index.js', import.meta.url))
  const params = existsSync(split) ? 'code, opts = {}, jzify = null' : 'code, opts = {}'
  const args = existsSync(split) ? 'code, opts, jzify' : 'code, opts'
  const name = existsSync(split) ? 'compileInProcess' : '_compileInProcess'
  const find = `export function ${name}(${params}) {`
  const wrap = `${find} return globalThis.__jzHash ? globalThis.__jzHash(code, opts, () => __recordedCompile(${args})) : __recordedCompile(${args}) }\nfunction __recordedCompile(${params}) {`
  // One hook registration: JZ_MUTANT_EDITS (test/_mutant.mjs's format) rides along, so a
  // knockout's outputs can be recorded against the unedited run's.
  const mutant = process.env.JZ_MUTANT_EDITS ? JSON.parse(process.env.JZ_MUTANT_EDITS) : {}
  register('./_mutant-hooks.mjs', import.meta.url, { data: { edits: { ...mutant, [index]: [[find, wrap]] } } })
  const entries = new Map(), measurements = new Map()
  const rawOpt = process.env.JZ_TEST_OPTIMIZE
  const defaults = { host: process.env.JZ_TEST_HOST || 'js', optimize: rawOpt == null ? 2 : /^-?\d+$/.test(rawOpt) ? Number(rawOpt) : rawOpt === 'false' ? false : rawOpt }
  if (process.env.JZ_TEST_STRICT) defaults.strict = process.env.JZ_TEST_STRICT === '1'
  globalThis.__jzHash = (code, opts, run) => {
    const effective = { ...opts }
    for (const [k, v] of Object.entries(defaults)) if (effective[k] == null) effective[k] = v
    const key = sha(`${typeof code === 'string' ? code : canon(code)}\0${canon(effective)}`)
    let e = entries.get(key)
    if (!e) entries.set(key, e = [String(code).slice(0, 160), new Set()])
    const started = performance.now()
    try { const r = run(); e[1].add(outcome(r)); return r }
    catch (err) { e[1].add(`error:${sha(`${err?.name}:${err?.message}`)}`); throw err }
    finally {
      const m = measurements.get(key) || { calls: 0, ms: 0 }
      m.calls++; m.ms += performance.now() - started
      measurements.set(key, m)
    }
  }
  process.on('exit', () => {
    const sorted = [...entries.keys()].sort().map(k => [k, [entries.get(k)[0], [...entries.get(k)[1]].sort()]])
    const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith('JZ_TEST_')))
    writeFileSync(out, JSON.stringify({ meta: { env, keys: sorted.length, calls: [...measurements.values()].reduce((n, m) => n + m.calls, 0) }, entries: Object.fromEntries(sorted), measurements: Object.fromEntries(measurements) }) + '\n')
  })
}

if (process.argv[1] === fileURLToPath(import.meta.url)) compare(process.argv[2], process.argv[3])
else if (!process.env.JZ_HASHES) throw new Error('_hashes: set JZ_HASHES=<out.json>')
else if (isMainThread) record(process.env.JZ_HASHES)
