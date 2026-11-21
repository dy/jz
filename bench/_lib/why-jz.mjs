#!/usr/bin/env node
// usage: node why-jz.mjs <case-id> <case.js> <lane flags as JSON>
// What a case's `main` throws, and where. A bench build keeps the raw ABI (`alloc: false`),
// which exports neither the error's tag nor its bits: its host sees a WebAssembly.Exception of
// no content and nothing says why the lane failed. The same case built at the same flags
// with the host ABI crosses its thrown value as JavaScript delivers it (interop.js
// decodeThrown). Run once, outside every timing; one line, `threw: …` or `returned`.
// A case that threw is built once more with every throw a trap (`noEhAbort`), whose
// frames are the module's functions: `threw: …; raised in f < g < main`, innermost first,
// and once at level 1, where each function of the source is one of the module's: its
// frames, or `returned` where only the lane's level throws.
import { performance } from 'node:perf_hooks'
import { instantiate } from '../../interop.js'
import { compileInternal } from '../../src/compiler.js'
import jzify from '../../jzify/index.js'
import { compileJzAt } from './compile.js'

const [id, js, flags] = process.argv.slice(2)
if (!js) { console.error('usage: why-jz.mjs <case-id> <case.js> <lane flags as JSON>'); process.exit(2) }

const said = (v) => v instanceof Error ? `${v.name}: ${v.message}`
  : typeof v === 'string' ? JSON.stringify(v)
  : v !== null && typeof v === 'object' ? `${v.constructor?.name ?? 'object'} ${JSON.stringify(v)?.slice(0, 200)}`
  : String(v)
const lane = JSON.parse(flags || '{}'), PLAIN = { level: 1 }
// `main` of the case as `compiler` builds it at `level`: returns, or throws what it threw
const run = async (compiler, level = lane) => {
  const module = await WebAssembly.compile(compileJzAt({ id, js }, level, compiler, true))
  const imports = { env: { logResult: () => {} }, performance: { now: () => performance.now() } }
  for (const { module: m, name, kind } of WebAssembly.Module.imports(module)) {
    if (kind !== 'function' || imports[m]?.[name] ||
        m === 'env' && /^(?:__ext_|parseInt$|parseFloat$|print$)/.test(name)) continue
    ;(imports[m] ??= {})[name] = () => undefined
  }
  instantiate(module, { imports }).exports.main()
}
// The functions of a trap's frames, innermost first: a frame names its function by index, and
// the build's text lists them in that order, the imports first. A helper that only throws and
// the module's start are no place of the program's.
const trapped = (extra) => (code, opts) => compileInternal(code, { ...opts, noEhAbort: true, ...extra }, jzify)
const raisedIn = async (level) => {
  try { await run(trapped(), level) } catch (e) {
    const at = [...String(e?.stack ?? '').matchAll(/wasm-function\[(\d+)\]/g)].map(m => +m[1])
    if (!at.length) return ''
    const text = String(compileJzAt({ id, js }, level, trapped({ wat: true }), true))
    const names = [...text.matchAll(/\((?:import "[^"]*" "[^"]*"\s*\(func (\$[^\s()]+)|func (\$[^\s()]+))/g)].map(m => m[1] ?? m[2])
    const fns = at.map(i => (names[i] ?? `#${i}`).replace(/^\$/, '').replace(/[-]/g, '.').replace(/\$exp$/, ''))
      .filter((n, i, all) => !/^__throw_|^__start$/.test(n) && n !== all[i - 1])
    return fns.length ? `raised in ${fns.slice(0, 6).join(' < ')}` : ''
  }
  return 'returned'
}
try {
  await run(undefined)
  console.log('returned')
} catch (e) {
  const where = []
  for (const [label, level] of [['', lane], ['at level 1: ', PLAIN]]) {
    if (label && JSON.stringify(level) === JSON.stringify(lane)) continue
    let at = ''
    try { at = await raisedIn(level) } catch {}
    // (the lane's own build threw: `returned` there says only that the trapped build differs)
    if (at && (label || at !== 'returned')) where.push(label + at)
  }
  console.log(`threw: ${said(e)}${where.map(w => '; ' + w).join('')}`)
}
