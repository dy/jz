// Compile watr via jz and emit the watr-optimized module consumed by wasm2c.
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const JZ_ROOT = path.resolve(__dirname, '../..')
const BUILD_DIR = process.env.BUILD_DIR || '/tmp/jz-c'

const { compile: jzCompile } = await import(path.join(JZ_ROOT, 'index.js'))
const watrSrc = (p) => fs.readFileSync(path.join(JZ_ROOT, 'node_modules/watr', p), 'utf8')

fs.mkdirSync(BUILD_DIR, { recursive: true })

const bin = jzCompile(watrSrc('src/compile.js'), {
  jzify: true,
  host: 'native',      // wasm2c/native-lowering TargetProfile (audit-#11, src/session.js) —
                        // noTailCall is one of its frozen policy fields: wasm2c has codegen
                        // bugs with `return_call` + multi-value, verified live on this pipeline
  memory: 4096,       // 256MB — absorb bump-heap accumulation across bench iters
  modules: {
    './encode.js': watrSrc('src/encode.js'),
    './const.js':  watrSrc('src/const.js'),
    './parse.js':  watrSrc('src/parse.js'),
    './util.js':   watrSrc('src/util.js'),
  },
})
const rawPath = path.join(BUILD_DIR, 'jz-watr.wasm')
fs.writeFileSync(rawPath, bin)
console.log('wrote', rawPath, bin.length, 'bytes')

// Validation here is deliberate: stage 0 must fail before wasm2c if an internal
// optimizer change emits an invalid module. No Binaryen normalization is involved.
const mod = new WebAssembly.Module(bin)
console.log('\nImports:')
for (const i of WebAssembly.Module.imports(mod)) console.log(' ', i.module, i.name, i.kind)
console.log('\nExports:')
for (const e of WebAssembly.Module.exports(mod)) console.log(' ', e.name, e.kind)
