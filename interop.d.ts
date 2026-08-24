import type {
  JzCarrier,
  JzExports,
  JzInstance,
  JzMemory,
  JzPointer,
  JzScalarMemory,
} from './index.js'

export type { JzCarrier, JzInstance, JzMemory, JzPointer, JzScalarMemory }

export interface InteropOptions {
  imports?: Record<string, unknown>
  memory?: WebAssembly.Memory | JzMemory
  write?: (fd: number, text: string) => void
  read?: (fd: number, buffer: Uint8Array) => number | void
  [key: string]: unknown
}

export interface MemoryDescriptor extends WebAssembly.MemoryDescriptor {}
export type MemoryInstanceSource =
  | JzInstance
  | WebAssembly.Instance
  | { module?: WebAssembly.Module; instance?: WebAssembly.Instance; exports?: WebAssembly.Exports; memory?: WebAssembly.Memory }

export const NULL_NAN: bigint
export const UNDEF_NAN: bigint
export const FALSE_NAN: bigint
export const TRUE_NAN: bigint

export function f64ToI64(value: number): bigint
export function i64ToF64(value: bigint): number
export function coerce<T>(value: T): T | bigint
export function ptr(type: number, aux: number, offset: number): JzPointer
export function offset(pointer: JzCarrier): number
export function type(pointer: JzCarrier): number
export function aux(pointer: JzCarrier): number

export function memory(): JzMemory
export function memory(source: WebAssembly.Memory | MemoryDescriptor): JzMemory
export function memory(source: MemoryInstanceSource): JzMemory | JzScalarMemory

/** Low-level export adaptation. Prefer `instantiate()` for new integrations. */
export function wrap(
  moduleOrResult: WebAssembly.Module | MemoryInstanceSource,
  instance?: WebAssembly.Instance,
  state?: unknown,
): JzExports

export function toModule(wasm: WebAssembly.Module | Uint8Array | ArrayBuffer): WebAssembly.Module
export function instantiate(
  wasm: WebAssembly.Module | Uint8Array | ArrayBuffer,
  opts?: InteropOptions,
): JzInstance
