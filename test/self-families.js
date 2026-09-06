// Native and hosted differential over the wrong-code family corpus (test/_families.js).
// Native leg: every case at O0, O1 and O2 against its authored results, which
// are first checked against Node running the same source, so a matching pair of
// wrong compilers cannot pass. Hosted leg (JZ_SELF_FAMILIES=1: a fresh private
// kernel, minutes): every case compiled through the kernel at O1 and O2, its
// bytes against the native compile and its results against the same authored
// values, then the corpus again on one warm instance A, A, B… with and without
// `_clear()`. A red case is a defect, recorded or new; the recorded ones name
// their leg in the corpus, and none is blessed by the expectation.
//
// Run: node test/self-families.js               native leg
//      JZ_SELF_FAMILIES=1 node test/self-families.js   both legs
import test from 'tst'
import { is, ok } from 'tst/assert.js'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { compile } from '../index.js'
import { instantiate } from '../interop.js'
import { onKernel } from './_matrix.js'
import { FAMILIES } from './_families.js'

const HOSTED = process.env.JZ_SELF_FAMILIES === '1'
const show = v => typeof v === 'bigint' ? `${v}n` : JSON.stringify(v)
// One call's outcome, comparable across the host, native and hosted modules.
const outcome = (fn, args) => {
  try { return { value: fn(...args) } }
  catch (e) { return e != null && typeof e === 'object' ? ('thrown' in e ? { thrown: e.thrown, throws: e.constructor.name } : { throws: e.constructor.name }) : { thrown: e } }
}
const matches = (got, expected) => {
  if (expected != null && typeof expected === 'object' && ('throws' in expected || 'thrown' in expected)) {
    if ('thrown' in expected) return Object.is(got.thrown, expected.thrown)
    return got.throws === expected.throws
  }
  return 'value' in got && Object.is(got.value, expected)
}
const describe = got => 'value' in got ? show(got.value) : 'thrown' in got ? `throws ${show(got.thrown)}` : `throws ${got.throws}`
const oracle = async (src) => {
  const dir = mkdtempSync(join(tmpdir(), 'jz-families-'))
  try { writeFileSync(join(dir, 'm.mjs'), src); return await import(pathToFileURL(join(dir, 'm.mjs')).href + '?' + Math.random()) }
  finally { setTimeout(() => rmSync(dir, { recursive: true, force: true }), 5000).unref() }
}
const check = (ex, calls, label) => { for (const [fn, args, expected] of calls) { const got = outcome(ex[fn], args); ok(matches(got, expected), `${label}: ${fn}(${args.map(show).join(', ')}) → ${describe(got)}, expected ${show(expected)}`) } }

for (const { family, cases } of FAMILIES) for (const c of cases) test(`family ${family}: ${c.name}${c.red?.native ? ` [red native: ${c.red.native}]` : ''}`, async () => {
  if (onKernel()) return
  const js = await oracle(c.src)
  for (const [fn, args, expected] of c.calls) { const got = outcome(js[fn], args); ok(matches(got, expected), `Node: ${fn}(${args.map(show).join(', ')}) → ${describe(got)}, the authored ${show(expected)} is wrong`) }
  for (const level of [0, 1, 2]) check(instantiate(compile(c.src, { optimize: level }), { memory: 64 }).exports, c.calls, `O${level}`)
})

if (HOSTED) {
  const { selfBytes } = await import('./_self-build.js')
  const same = (a, b) => a.length === b.length && a.every((x, i) => x === b[i])
  const compileOn = (k, src, level) => {
    const out = k.exports.default(k.memory.String(src), 0, k.memory.String(JSON.stringify({ level })))
    const bin = k.memory.read(out)
    const bytes = new Uint8Array(bin instanceof Uint8Array ? bin : new Uint8Array(bin))
    if (!WebAssembly.validate(bytes)) throw new Error('the kernel returned invalid wasm')
    return bytes
  }
  for (const { family, cases } of FAMILIES) for (const c of cases) test(`hosted family ${family}: ${c.name}${c.red?.hosted ? ` [red hosted: ${c.red.hosted}]` : ''}`, () => {
    for (const level of [1, 2]) {
      const k = instantiate(selfBytes(), { memory: 8192 })
      const bytes = compileOn(k, c.src, level)
      ok(same(bytes, compile(c.src, { optimize: level })), `O${level}: the kernel's bytes are the native compile's`)
      check(instantiate(bytes, { memory: 64 }).exports, c.calls, `hosted O${level}`)
    }
  })
  for (const clear of [true, false]) test(`hosted families on one warm instance, A, A, B… ${clear ? 'with' : 'without'} _clear()`, () => {
    const k = instantiate(selfBytes(), { memory: 8192 })
    const all = FAMILIES.flatMap(f => f.cases)
    let previous = null
    for (const c of all) {
      for (const pass of [1, 2]) {
        let bytes, error = null
        try { bytes = compileOn(k, c.src, 1) } catch (e) { error = e }
        ok(!error, `${c.name} (pass ${pass}): ${error?.message.split('\n')[0]}`)
        if (bytes) ok(same(bytes, compile(c.src, { optimize: 1 })), `${c.name} (pass ${pass}): native bytes`)
        if (clear) k.exports._clear()
      }
      if (previous) ok(same(compileOn(k, previous.src, 1), compile(previous.src, { optimize: 1 })), `${previous.name} again after ${c.name}`)
      if (clear) k.exports._clear()
      previous = c
    }
  })
}
