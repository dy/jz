export interface WasiOptions {
  write?: (fd: number, text: string) => void
  read?: (fd: number, buffer: Uint8Array) => number | void
}

export interface JzWasiImports {
  wasi_snapshot_preview1: Record<string, (...args: any[]) => number | void>
  /** Called after instantiation so syscall shims can access exported memory. */
  _setMemory(memory: WebAssembly.Memory): void
}

/** Build the small WASI Preview 1 import set emitted by jz. */
export function wasi(opts?: WasiOptions): JzWasiImports

/** Drive a jz WASI module's exported timer queue, when present. */
export function attachTimers(instance: WebAssembly.Instance): void

/** Instantiate already-compiled `host: 'wasi'` bytes. */
export function instantiate(
  wasm: Uint8Array | ArrayBuffer,
  opts?: WasiOptions,
): WebAssembly.Instance
