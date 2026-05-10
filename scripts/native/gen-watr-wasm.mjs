// Compile watr via jz, emit watr.wasm to $BUILD_DIR/jz-watr.wasm,
// then run wasm-opt -O3 to produce $BUILD_DIR/jz-watr-opt.wasm (the input to wasm2c).
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { execSync } from 'child_process'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const JZ_ROOT = path.resolve(__dirname, '../..')
const BUILD_DIR = process.env.BUILD_DIR || '/tmp/jz-c'
const WASM_OPT = process.env.WASM_OPT || 'wasm-opt'

const { compile: jzCompile } = await import(path.join(JZ_ROOT, 'index.js'))
const watrSrc = (p) => fs.readFileSync(path.join(JZ_ROOT, 'node_modules/watr', p), 'utf8')

fs.mkdirSync(BUILD_DIR, { recursive: true })

const bin = jzCompile(watrSrc('src/compile.js'), {
  jzify: true,
  noTailCall: true,        // wasm2c has codegen bugs with `return_call` + multi-value
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

const FEATS = [
  '--enable-bulk-memory', '--enable-bulk-memory-opt',
  '--enable-exception-handling', '--enable-multivalue',
  '--enable-nontrapping-float-to-int', '--enable-mutable-globals',
  '--enable-sign-ext',
].join(' ')
const optPath = path.join(BUILD_DIR, 'jz-watr-opt.wasm')
execSync(`${WASM_OPT} -O3 ${FEATS} ${rawPath} -o ${optPath}`, { stdio: 'inherit' })
console.log('wrote', optPath, fs.statSync(optPath).size, 'bytes')

const mod = new WebAssembly.Module(fs.readFileSync(optPath))
console.log('\nImports:')
for (const i of WebAssembly.Module.imports(mod)) console.log(' ', i.module, i.name, i.kind)
console.log('\nExports:')
for (const e of WebAssembly.Module.exports(mod)) console.log(' ', e.name, e.kind)
