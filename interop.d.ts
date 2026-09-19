import type {
  JzCarrier,
  JzExports,
  JzInstance,
  JzMemory,
  JzPointer,
  JzScalarMemory,
} from './index.js'

export type { JzCarrier, JzExports, JzInstance, JzMemory, JzPointer, JzScalarMemory }

export interface InteropOptions {
  /** Host modules for the module's `import { fn } from "mod"` declarations. */
  imports?: Record<string, unknown>
  /** Memory to link instead of the module's own export. */
  memory?: WebAssembly.Memory | JzMemory
  /** WASI stdout/stderr and stdin for `host: 'wasi'` modules. */
  write?: (fd: number, text: string) => void
  read?: (fd: number, buffer: Uint8Array) => number | void
}

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
