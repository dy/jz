import test from 'tst'
import { is, ok, throws } from 'tst/assert.js'
import { Session } from 'node:inspector'
import { compile, instantiate } from '../index.js'
import watrCompile from 'watr/compile'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Source Map v3 VLQ decoder, independent of the encoder.
const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
const entries = map => {
  let generated = 0, source = 0, line = 0, column = 0
  return map.mappings.split(',').filter(Boolean).map(segment => {
    const values = []; let n = 0, shift = 0
    for (const c of segment) {
      const v = alphabet.indexOf(c); n += (v & 31) * 2 ** shift
      if (v & 32) shift += 5
      else { values.push(n & 1 ? -(n >>> 1) : n >>> 1); n = shift = 0 }
    }
    generated += values[0]
    if (values.length === 1) return { offset: generated }
    source += values[1]; line += values[2]; column += values[3]
    return { offset: generated, source: map.sources[source], line, column }
  })
}
const source = `export function calc(x) {
 let y = x + 2;
 y = y * x;
 if (y > 5) {
   y = y - 1;
 }
 return y;
}`

test('source maps: source statements survive lowering, branches and encoding', () => {
  const b = compile(source, { sourceMap: { source: 'calc.js', url: false } })
  is(instantiate(b).exports.calc(3), 14)
  is(instantiate(b).exports.calc(1), 3)
  is(b.sourceMap.sourcesContent, [source])
  const rows = entries(b.sourceMap).filter(p => p.source)
  is([...new Set(rows.map(p => p.line))], [1, 2, 3, 4, 6])
  ok(rows.every((p, i) => p.offset < b.length && (!i || p.offset > rows[i - 1].offset)))
  // Markers encode no instructions; with the same symbol section debug bytes agree.
  is(b, compile(source, { optimize: false, names: true }))
  is(WebAssembly.Module.customSections(new WebAssembly.Module(b), 'sourceMappingURL').length, 0)
  is(compile(source).sourceMap, undefined, 'debug state does not leak to the next compilation')
  throws(() => compile(source, { sourceMap: true, optimize: 'speed' }), /requires optimize: false/)
  const wat = compile(source, { sourceMap: { source: 'a folder/a"b.js' }, wat: true })
  is(watrCompile(wat).sourceMap.sources, ['a folder/a"b.js'], 'WAT annotations preserve filename punctuation')
  for (const code of ['export let f=x=>x', 'export function f(x){return x}', 'export let f=()=>4']) {
    const binary = compile(code, { sourceMap: true })
    ok(entries(binary.sourceMap).some(p => p.source), 'bare return has an origin')
    is(instantiate(binary).exports.f(4), 4)
  }
})

test('source maps: imports, Unicode, line terminators, shebang and injected defines', () => {
  const dep = 'export function twice(x) {\n const δ = x * 2;\n return δ;\n}'
  const entry = '#!/usr/bin/env node\r\nimport {twice} from "./dep.js";\r\nexport let f = x => {\r\n let y = twice(x);\r return y + EXTRA;\u2028}'
  const b = compile(entry, { modules: { './dep.js': dep }, define: { EXTRA: 1 }, sourceMap: { source: 'entry.js', url: 'out.wasm.map' } })
  is(instantiate(b).exports.f(4), 9)
  const rows = entries(b.sourceMap)
  for (const [file, text] of [['entry.js', entry], ['./dep.js', dep]]) {
    const idx = b.sourceMap.sources.indexOf(file)
    ok(idx >= 0, `${file} is included`)
    is(b.sourceMap.sourcesContent[idx], text)
  }
  ok(rows.some(p => p.source === 'entry.js' && p.line === 4), 'return line after CR and shebang')
  ok(rows.some(p => p.source === './dep.js' && p.line === 2), 'imported return maps to its own source')
})

test('source maps: cached import graphs retain origins across empty and repeated compiles', () => {
  const entry = 'import {f} from "./a.js"; export const run = x => f(x) + 1'
  for (const value of [2, 2, 7, 2]) {
    const leaf = `export const value = x => x * ${value}`
    const modules = { './a.js': 'import {value} from "./b.js"; export const f = x => value(x) + 1', './b.js': leaf }
    const binary = compile(entry, { modules, sourceMap: { source: 'entry.js', url: false } })
    is(instantiate(binary).exports.run(2), 2 * value + 2)
    for (const [file, content] of Object.entries({ 'entry.js': entry, ...modules })) {
      const rows = entries(binary.sourceMap).filter(p => p.source === file)
      ok(rows.length > 0 && rows.every(p => p.line === 0), `${file} maps to its single source line`)
      is(binary.sourceMap.sourcesContent[binary.sourceMap.sources.indexOf(file)], content)
    }
    const empty = compile('', { sourceMap: true })
    is(Object.keys(instantiate(empty).exports), [])
    is(empty.sourceMap.sources, [], 'an empty module inherits no import sources')
  }
})

test('source maps: V8 debugger stops at a mapped source statement', async () => {
  const session = new Session(); session.connect()
  const post = (method, params = {}) => new Promise((resolve, reject) => session.post(method, params, (e, r) => e ? reject(e) : resolve(r)))
  try {
    await post('Debugger.enable')
    let script, paused
    session.on('Debugger.scriptParsed', ({ params }) => { if (params.scriptLanguage === 'WebAssembly') script = params })
    session.on('Debugger.paused', ({ params }) => { paused = params.callFrames[0].location; session.post('Debugger.resume') })
    const b = compile(source, { sourceMap: { source: 'debug/calc.js' } })
    const instance = new WebAssembly.Instance(new WebAssembly.Module(b))
    const fromDebugger = JSON.parse(decodeURIComponent(script.sourceMapURL.split(',').slice(1).join(',')))
    is(fromDebugger, b.sourceMap, 'debugger discovers the embedded map')
    const row = entries(fromDebugger).find(p => p.line === 4)
    const location = { scriptId: script.scriptId, lineNumber: 0, columnNumber: row.offset }
    const bp = await post('Debugger.setBreakpoint', { location })
    is(bp.actualLocation, location, 'mapped byte offset is an exact breakpoint')
    is(instance.exports.calc(3), 14)
    is(paused, location, 'execution stopped on the original subtraction line')
  } finally { session.disconnect() }
})

test('source maps: CLI emits a discoverable external map beside the binary', () => {
  const dir = mkdtempSync(join(tmpdir(), 'jz-source-map-'))
  try {
    const input = join(dir, 'calc.js'), output = join(dir, 'calc.wasm')
    writeFileSync(input, source)
    execFileSync(process.execPath, [new URL('../cli.js', import.meta.url).pathname, input, '--source-map'], { stdio: 'pipe' })
    const map = JSON.parse(readFileSync(output + '.map', 'utf8'))
    is(map.sourcesContent, [source])
    const bytes = readFileSync(output)
    is(instantiate(bytes).exports.calc(3), 14)
    ok(WebAssembly.Module.customSections(new WebAssembly.Module(bytes), 'sourceMappingURL').length === 1)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
