import type {
  InteropOptions,
  JzCarrier,
  JzExports,
  JzInstance,
  JzMemory,
  JzPointer,
} from './index.js'

export type { InteropOptions, JzCarrier, JzExports, JzInstance, JzMemory, JzPointer }

/** Instantiate prebuilt jz wasm: marshals values, decodes errors, links WASI when present. */
export function instantiate(
  wasm: WebAssembly.Module | Uint8Array | ArrayBuffer,
  opts?: InteropOptions,
): JzInstance
