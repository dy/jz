// Public TypeScript surface for jz.

/** Optimization level / preset. `2` is the default stable profile. */
export type OptimizeLevel = boolean | 0 | 1 | 2 | 3 | 'speed' | 'size' | 'fast'

/** Runtime-service lowering target. */
export type Host = 'js' | 'wasi' | 'native'

/** Value injectable through `define`. */
export type DefineValue = number | boolean | string | null | DefineValue[] | { [k: string]: DefineValue }

/** Raw NaN-box carrier used by the low-level memory API. */
export type JzPointer = bigint
export type JzCarrier = number | bigint

export interface WarningEntry {
  code: string
  message: string
  fn?: string
  line?: number
  column?: number
  [key: string]: unknown
}

export interface WarningSink {
  entries?: WarningEntry[]
  [key: string]: unknown
}

export interface ProfileSink {
  entries?: unknown[]
  totals?: Record<string, number>
  [key: string]: unknown
}

/** Intentionally opaque until a later stable inspection schema is published. */
export type CompileInspection = Record<string, unknown>

export interface CompileOptions {
  /** Static ES imports to bundle: `{ './dep.js': 'export let x = 1' }`. */
  modules?: Record<string, string>
  /** Host imports wired at runtime. */
  imports?: Record<string, unknown>
  /** Initial pages for owned memory, or memory shared with the module. */
  memory?: number | WebAssembly.Memory | JzMemory
  /** Maximum memory in 64 KiB pages. */
  maxMemory?: number
  /** Import `env.memory` instead of exporting owned memory. */
  importMemory?: boolean
  /** Runtime-service lowering. Default: `'js'`. */
  host?: Host
  /** Optimization level or named preset. Default: `2`. */
  optimize?: OptimizeLevel
  define?: Record<string, DefineValue>
  /** Skip jzify and reject dynamic fallback paths. */
  strict?: boolean
  /** Set `false` to omit `_alloc`/`_clear`. */
  alloc?: boolean
  noSimd?: boolean
  whyNotSimd?: boolean
  stencil?: boolean
  outerStrip?: boolean
  toneMap?: boolean
  noTailCall?: boolean
  noEhAbort?: boolean
  sharedMemory?: boolean
  nativeTimers?: boolean
  warnings?: WarningSink
  randomSeed?: number | boolean
  names?: boolean
  wat?: boolean
  profile?: ProfileSink
  /** URL used to lower `import.meta.url` and static `import.meta.resolve()`. */
  importMetaUrl?: string
  /** Return the unstable inspection payload beside wasm/WAT. */
  inspect?: boolean
}

export interface AllocatedTyped<T extends ArrayBufferView = ArrayBufferView> {
  view: T
  box: JzPointer
}

export interface TypedArrayMemoryConstructor {
  (data: ArrayLike<number>): JzPointer
}

export interface BigIntTypedArrayMemoryConstructor {
  (data: ArrayLike<bigint>): JzPointer
}

/** Enhanced WebAssembly memory and its value-codec methods. */
export interface JzMemory extends WebAssembly.Memory {
  String(str: string): JzPointer
  Array(data: ArrayLike<unknown>): JzPointer
  Object(obj: Record<string, unknown>): JzPointer
  Hash(obj: Record<string, unknown>): JzPointer
  Buffer(data: ArrayBuffer | ArrayBufferView | ArrayLike<number>): JzPointer
  BigInt(value: bigint): JzPointer
  External(value: object | Function | null | undefined): JzPointer

  Float64Array: TypedArrayMemoryConstructor
  Float32Array: TypedArrayMemoryConstructor
  Float16Array: TypedArrayMemoryConstructor
  Int32Array: TypedArrayMemoryConstructor
  Uint32Array: TypedArrayMemoryConstructor
  Int16Array: TypedArrayMemoryConstructor
  Uint16Array: TypedArrayMemoryConstructor
  Int8Array: TypedArrayMemoryConstructor
  Uint8Array: TypedArrayMemoryConstructor
  Uint8ClampedArray: TypedArrayMemoryConstructor
  BigInt64Array: BigIntTypedArrayMemoryConstructor
  BigUint64Array: BigIntTypedArrayMemoryConstructor

  read(value: JzCarrier | readonly JzCarrier[]): unknown
  wrapVal(value: unknown): JzCarrier
  write(pointer: JzPointer, value: ArrayLike<unknown> | Record<string, unknown>): void
  alloc(bytes: number): number
  allocTyped<T extends ArrayBufferView>(
    Ctor: new (buffer: ArrayBufferLike, byteOffset: number, length: number) => T,
    length: number,
  ): AllocatedTyped<T>
  reset(): void
  schemas?: unknown[]
}

/** Reader returned by `memory(instance)` for a scalar, memoryless module. */
export interface JzScalarMemory {
  readonly scalar: true
  read(value: JzCarrier | readonly JzCarrier[]): unknown
  wrapVal(value: unknown): JzCarrier
}

export type JzExports = Record<string, any>

export interface JzInstance<E extends JzExports = JzExports> {
  exports: E
  memory: JzMemory | null
  instance: WebAssembly.Instance
  module: WebAssembly.Module
  /** Present only when compilation used `{ inspect: true }`. */
  inspect?: CompileInspection
  /** Present when the caller supplied a warning sink. */
  warnings?: WarningEntry[]
}

export interface MemoryFactory {
  (): JzMemory
  (memory: WebAssembly.Memory): JzMemory
  (descriptor: WebAssembly.MemoryDescriptor): JzMemory
  (instance: JzInstance): JzMemory | JzScalarMemory
}

export interface JzPool {
  exports: JzExports
  memory: JzMemory
  module: WebAssembly.Module
  threads: number
  run(fn: string, ...args: unknown[]): Promise<unknown[]>
  terminate(): Promise<unknown[]>
}

export interface PoolOptions extends Omit<CompileOptions, 'memory' | 'maxMemory' | 'sharedMemory' | 'wat' | 'inspect'> {
  threads?: number
  pages?: number
  maxPages?: number
}

export interface Jz {
  (code: string, opts?: CompileOptions & { wat?: false }): JzInstance
  (strings: TemplateStringsArray, ...values: unknown[]): JzInstance
  compile: typeof compile
  memory: MemoryFactory
  pool(source: string, opts?: PoolOptions): Promise<JzPool>
}

export interface TransformOptions {
  onlyLowered?: boolean
  warnings?: WarningSink | null
}

export interface InspectedWasm { wasm: Uint8Array; inspect: CompileInspection }
export interface InspectedWat { wat: string; inspect: CompileInspection }

declare const jz: Jz
export default jz
export { jz }

export function compile(code: string, opts: CompileOptions & { wat: true; inspect: true }): InspectedWat
export function compile(code: string, opts: CompileOptions & { wat?: false; inspect: true }): InspectedWasm
export function compile(code: string, opts: CompileOptions & { wat: true; inspect?: false }): string
export function compile(code: string, opts?: CompileOptions & { wat?: false; inspect?: false }): Uint8Array
export function compile(code: string, opts?: CompileOptions): Uint8Array | string | InspectedWasm | InspectedWat

export function compileModule(
  code: string,
  opts?: CompileOptions & { wat?: false; inspect?: false },
): WebAssembly.Module

export function instantiate(
  module: WebAssembly.Module | Uint8Array | ArrayBuffer,
  opts?: CompileOptions,
): JzInstance

export function transform(code: string, opts?: TransformOptions): string | null

/** Stable presets resolve to optimizer options; the object shape is internal. */
export function resolveWatrOpts(config: unknown, context?: { funcCount?: number; boundaryPins?: string[] }): object | false
