import type {
  InstantiateOptions,
  JzCarrier,
  JzExports,
  JzInstance,
  JzMemory,
  JzPointer,
} from './index.js'

export type { InstantiateOptions, JzCarrier, JzExports, JzInstance, JzMemory, JzPointer }

/** Instantiate prebuilt jz wasm: marshals values, decodes errors, links WASI when present. */
export function instantiate(
  wasm: WebAssembly.Module | Uint8Array | ArrayBuffer,
  opts?: InstantiateOptions,
): JzInstance
