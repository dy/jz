import jz, { compile, instantiate, type CompileOptions, type InstantiateOptions, type JzOptions, type JzPointer, type Warning } from 'jz'
import { instantiate as instantiateInterop } from 'jz/interop'

const mem = jz.memory()
const pointer: JzPointer = mem.String('jz')
const floats: JzPointer = mem.Float64Array([1, 2, 3])
mem.write(pointer, ['updated'])
const decoded: unknown = mem.read(floats)
mem.reset()

const bytes: Uint8Array = compile('export let f = () => 1')
const wat: string = compile('export let f = () => 1', { wat: true })
const mapped = compile('export let f = () => 1', { sourceMap: { source: 'kernel.js', url: false } })
const sourceNames: string[] | undefined = mapped.sourceMap?.sources
const opts: CompileOptions = {
  host: 'wasi',
  memory: { initial: 4, maximum: 64 },
  optimize: { level: 'speed', simd: false, relaxedSimd: false, tailCall: false },
  warnings: (w) => { void w.code },
  why: true,
  define: { EMPTY: undefined, DATA: { 'a-b': -0, values: [undefined, null] } },
}
const fixed: CompileOptions = { memory: { fixed: ['process'] as const } }
void fixed
const tuned: Uint8Array = compile('export let f = () => 1', { ...opts, wat: false })
const result = jz('export let f = () => 1')
const shared = jz('export let f = () => 1', { memory: jz.memory() })
const wrapped = instantiateInterop(bytes)
// @ts-expect-error the subpath exports instantiate alone
import('jz/interop').then(m => m.memory())
const again = instantiate(bytes, { imports: { host: { log: console.log } } })
// @ts-expect-error instantiate takes no compile options
instantiate(bytes, { optimize: 'size' })
// @ts-expect-error compile is the named export alone
jz.compile('export let f = () => 1')
const closed: CompileOptions = { optimize: { level: 'size', compact: false, rationalConst: false } }
void closed
// @ts-expect-error a pass name is no optimize option
compile('export let f = () => 1', { optimize: { level: 'speed', stencil: false } })
// @ts-expect-error the levels are true, false, 'size' and 'speed'
compile('export let f = () => 1', { optimize: 3 })
// @ts-expect-error the hosts are 'js' and 'wasi'
compile('export let f = () => 1', { host: 'native' })
// @ts-expect-error a 0.9 spelling is no option
compile('export let f = () => 1', { maxMemory: 4 })
const seen: Warning[] = []
compile('export let f = () => 1', { warnings: (w) => { seen.push(w); void [w.file, w.line, w.column, w.fn] } })
const run: JzOptions = { optimize: 'size', imports: { host: { log: console.log } } }
jz('export let f = () => 1', run)
const link: InstantiateOptions = { imports: {} }
void [seen, link]
// @ts-expect-error jz() instantiates: no WAT
jz('export let f = () => 1', { wat: true })
// @ts-expect-error an import is a namespace, not a value
compile('export let f = () => 1', { imports: { host: 1 } })

// the memory: its constructors take data or a length; the codec stays private
const zeros: JzPointer = mem.Float32Array(4)
const bigZeros: JzPointer = mem.BigInt64Array(3)
const boxed: JzPointer = mem.BigInt(5n)
const used: number = mem.used
const fromDescriptor = jz.memory({ initial: 2, maximum: 8 })
const enhanced = jz.memory(new WebAssembly.Memory({ initial: 1 }))
// @ts-expect-error an instance's memory is its result's `memory`
jz.memory(result)
// @ts-expect-error the marshalling is the runtime's
mem.wrapVal(1)
// @ts-expect-error allocTyped goes: memory.read(memory.Uint8Array(n)) is the view
mem.allocTyped(Uint8Array, 4)
// instantiate: the memory a module imports, a WASI module's stdio
const opened: InstantiateOptions = { memory: enhanced, wasi: { write: (fd, text) => void [fd, text], read: (fd, buffer) => buffer.length } }
const linked = instantiate(bytes, opened)
const viaJz = jz('export let f = () => 1', { host: 'wasi', wasi: { write: () => {} } })
// @ts-expect-error stdio is instantiate's `wasi`
instantiate(bytes, { write: () => {} })
// @ts-expect-error a page count is the compiler's
instantiate(bytes, { memory: 4 })

void [decoded, wat, tuned, result, shared, wrapped, again, zeros, bigZeros, boxed, used, fromDescriptor, linked, viaJz]

