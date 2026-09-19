import jz, { compile, instantiate, type CompileOptions, type JzPointer } from 'jz'
import { memory, instantiate as instantiateInterop } from 'jz/interop'

const mem = memory()
const pointer: JzPointer = mem.String('jz')
const floats: JzPointer = mem.Float64Array([1, 2, 3])
mem.write(pointer, ['updated'])
const decoded: unknown = mem.read(floats)
mem.reset()

const bytes: Uint8Array = compile('export let f = () => 1')
const wat: string = compile('export let f = () => 1', { wat: true })
const opts: CompileOptions = {
  host: 'wasi',
  memory: { initial: 4, maximum: 64 },
  optimize: { level: 'speed', simd: false, tailCall: false },
  warnings: (w) => { void w.code },
  why: true,
}
const tuned: Uint8Array = compile('export let f = () => 1', { ...opts, wat: false })
const result = jz('export let f = () => 1')
const shared = jz('export let f = () => 1', { memory: jz.memory() })
const wrapped = instantiateInterop(bytes)
const again = instantiate(bytes, { optimize: 'size' })

void [decoded, wat, tuned, result, shared, wrapped, again]
