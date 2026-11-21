#!/usr/bin/env node
// usage: node why-jz.mjs <case-id> <case.js> <lane flags as JSON>
// What a case's `main` throws. A bench build keeps the raw ABI (`alloc: false`), which
// exports neither the error's tag nor its bits: its host sees a WebAssembly.Exception of
// no content and nothing says why the lane failed. The same case built at the same flags
// with the host ABI crosses its thrown value as JavaScript delivers it (interop.js
// decodeThrown). Run once, outside every timing; one line, `threw: …` or `returned`.
import { performance } from 'node:perf_hooks'
import { instantiate } from '../../interop.js'
import { compileJzAt } from './compile.js'

const [id, js, flags] = process.argv.slice(2)
if (!js) { console.error('usage: why-jz.mjs <case-id> <case.js> <lane flags as JSON>'); process.exit(2) }

const said = (v) => v instanceof Error ? `${v.name}: ${v.message}`
  : typeof v === 'string' ? JSON.stringify(v)
  : v !== null && typeof v === 'object' ? `${v.constructor?.name ?? 'object'} ${JSON.stringify(v)?.slice(0, 200)}`
  : String(v)
try {
  const module = await WebAssembly.compile(compileJzAt({ id, js }, JSON.parse(flags || '{}'), undefined, true))
  const imports = { env: { logResult: () => {} }, performance: { now: () => performance.now() } }
  for (const { module: m, name, kind } of WebAssembly.Module.imports(module)) {
    if (kind !== 'function' || imports[m]?.[name] ||
        m === 'env' && /^(?:__ext_|parseInt$|parseFloat$|print$)/.test(name)) continue
    ;(imports[m] ??= {})[name] = () => undefined
  }
  instantiate(module, { imports }).exports.main()
  console.log('returned')
} catch (e) {
  console.log(`threw: ${said(e)}`)
}
