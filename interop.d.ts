import type {
  InteropOptions,
  JzCarrier,
  JzExports,
  JzInstance,
  JzMemory,
  JzPointer,
  JzScalarMemory,
} from './index.js'

export type { InteropOptions, JzCarrier, JzExports, JzInstance, JzMemory, JzPointer, JzScalarMemory }

export type MemoryInstanceSource =
  | JzInstance
  | WebAssembly.Instance
  | { module?: WebAssembly.Module; instance?: WebAssembly.Instance; exports?: WebAssembly.Exports; memory?: WebAssembly.Memory }

/** Create a jz memory, enhance an existing one, or read a module's memory. */
export function memory(): JzMemory
export function memory(source: WebAssembly.Memory | WebAssembly.MemoryDescriptor): JzMemory
export function memory(source: MemoryInstanceSource): JzMemory | JzScalarMemory

/** Instantiate prebuilt jz wasm: marshals values, decodes errors, links WASI when present. */
export function instantiate(
  wasm: WebAssembly.Module | Uint8Array | ArrayBuffer,
  opts?: InteropOptions,
): JzInstance
