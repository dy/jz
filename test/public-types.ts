import jz, {
  compile,
  transform,
  type InspectedWasm,
  type JzPointer,
} from 'jz'
import {
  memory,
  instantiate as instantiateInterop,
  toModule,
  ptr,
} from 'jz/interop'
import transformSubpath from 'jz/transform'
import {
  wasi,
  attachTimers,
  instantiate as instantiateWasi,
} from 'jz/wasi'

const mem = memory()
const pointer: JzPointer = mem.String('jz')
const rawBox: bigint = ptr(4, 0, 0)
const rawOffset: number = mem.alloc(8)
const allocated: Uint8Array = mem.allocTyped(Uint8Array, 4).view
const bigintPointer: JzPointer = mem.BigInt64Array([1n])
mem.write(pointer, ['updated'])

const bytes: Uint8Array = compile('export let f = () => 1')
const inspected: InspectedWasm = compile('export let f = () => 1', { inspect: true })
const source: string | null = transform('let x = 1', { onlyLowered: true })
const sourceFromSubpath: string | null = transformSubpath('var x = 1')
const result = jz('export let f = () => 1')
const wrapped = instantiateInterop(toModule(bytes))
const imports = wasi({ write(fd, text) { void fd; void text } })
attachTimers(wrapped.instance)
const rawInstance = instantiateWasi(bytes)

void [rawBox, rawOffset, allocated, bigintPointer, inspected, source, sourceFromSubpath, result, imports, rawInstance]
