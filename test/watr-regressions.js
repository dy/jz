import test from 'tst'
import { ok, is } from 'tst/assert.js'
import jz from '../index.js'
import nativeCompile from '../node_modules/watr/src/compile.js'
import { readFileSync } from 'fs'

const watrSrc = file => readFileSync(new URL(`../node_modules/watr/src/${file}`, import.meta.url), 'utf8')

test('watr: compiled compile.js handles empty func module', async () => {
  const inst = await jz(watrSrc('compile.js'), {
    jzify: true,
    modules: {
      './encode.js': watrSrc('encode.js'),
      './const.js': watrSrc('const.js'),
      './parse.js': watrSrc('parse.js'),
      './util.js': watrSrc('util.js'),
    }
  })

  const compiled = inst.exports.default('(module (func))')
  const native = nativeCompile('(module (func))')

  ok(compiled instanceof Uint8Array, 'compiled watr returns wasm bytes')
  ok(new WebAssembly.Module(compiled) instanceof WebAssembly.Module, 'compiled watr output is valid wasm')
  is(compiled.length, native.length)
})