// Public TypeScript surface for jz.

/** Runtime services the module is compiled against. */
export type Host = 'js' | 'wasi' | 'native'

/** Value injectable through `define`. */
export type DefineValue = number | boolean | string | null | undefined | DefineValue[] | { [k: string]: DefineValue }

/** Raw NaN-box carrier used by the memory API. */
export type JzPointer = bigint
export type JzCarrier = number | bigint

export interface WarningEntry {
  code: string
  message: string
  fn?: string
  line?: number
  column?: number
}

/**
 * Owned memory: `initial` pages of 64 KiB, an optional growth `maximum`.
 * `shared` links a threads memory (atomic heap); `import` takes `env.memory`
 * from the host instead of exporting one.
 */
export interface MemoryOptions {
  initial?: number
  maximum?: number
  shared?: boolean
  import?: boolean
  /** Require selected Wasm exports to use fixed storage: no heap allocation,
   * growth, host calls, recursion or tracing. Excludes JS host marshalling. */
  fixed?: readonly string[]
}

/**
 * Advanced optimizer control on top of a preset `level`.
 * `simd` and `tailCall` are engine-capability switches. `exceptions: false`
 * traps on throw in catch-free modules and drops the exceptions tag.
 * `alloc: false` is the raw standalone ABI (no allocator or reset exports).
 * Any other key names an individual pass and is validated by name.
 */
export interface OptimizeOptions {
  level?: boolean | 'size' | 'speed'
  simd?: boolean
  tailCall?: boolean
  exceptions?: boolean
  alloc?: boolean
  /** Compact what the module keeps as each outermost call returns (owned memory). Default on. */
  compact?: boolean
  /** Entries of the stub log a loop's compaction reads: the blocks older than the loop that grew (default 65536, a megabyte of address space). */
  compactStubs?: number
  stencil?: boolean
  outerStrip?: boolean
  toneMap?: boolean
  [pass: string]: unknown
}

export interface SourceMapOptions {
  /** Entry source name or URL; defaults to input.js. */
  source?: string
  /** External map URL; false omits the URL section. Default: inline data URL. */
  url?: string | false
}

export interface SourceMap {
  version: 3
  sources: string[]
  sourcesContent: (string | null)[]
  names: string[]
  /** Generated columns are absolute Wasm byte offsets on line zero. */
  mappings: string
}

export interface CompiledWasm extends Uint8Array {
  sourceMap?: SourceMap
}

export interface CompileOptions {
  /** Static ES imports to bundle: `{ './dep.js': 'export let x = 1' }`. */
  modules?: Record<string, string>
  /** Host modules for `import { fn } from "mod"`: functions, constants, or a whole namespace. */
  imports?: Record<string, unknown>
  /** Compile-time constants injected as top-level bindings. */
  define?: Record<string, DefineValue>
  /** JS host (default), WASI, or the wasm2c native lane. */
  host?: Host
  /** Initial pages, a memory shared across modules, or a descriptor. */
  memory?: number | WebAssembly.Memory | JzMemory | MemoryOptions
  /** `true` (default) balanced, `'speed'`, `'size'`, `false` off, or an object. */
  optimize?: boolean | 'size' | 'speed' | OptimizeOptions
  /** Fixed seed for a reproducible `Math.random`; `true` requests host entropy. */
  randomSeed?: number | boolean
  /** Emit the wasm `name` section for profilers and debuggers. */
  names?: boolean
  /** Statement source map and function names. Selects optimize: false; other tiers reject. */
  sourceMap?: boolean | SourceMapOptions
  /** Return WAT text instead of the binary. */
  wat?: boolean
  /** Called with each compiler advisory once the compilation is over. */
  warnings?: (warning: WarningEntry) => void
  /** Also report to `warnings` every loop the vectorizer and every arena the rewind declined. */
  why?: boolean
}

export interface TypedArrayMemoryConstructor {
  (data: ArrayLike<number>): JzPointer
}

export interface BigIntTypedArrayMemoryConstructor {
  (data: ArrayLike<bigint>): JzPointer
}

/** Enhanced WebAssembly memory: allocate values on the jz heap and read them back. */
export interface JzMemory extends WebAssembly.Memory {
  String(str: string): JzPointer
  Array(data: ArrayLike<unknown>): JzPointer
  Object(obj: Record<string, unknown>): JzPointer

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

  /** Decode a raw result (pointer, number, or multi-value) into a JS value. */
  read(value: JzCarrier | readonly JzCarrier[]): unknown
  /** Replace the contents of an allocated array or object in place. */
  write(pointer: JzPointer, value: ArrayLike<unknown> | Record<string, unknown>): void
  /** Drop every allocation made since instantiation; invalidates earlier pointers. */
  reset(): void
  /** Bytes the heap holds above the mark `reset()` returns to: what calls kept and the host allocated. */
  readonly used: number
}

/** Reader returned by `memory(instance)` for a module without linear memory. */
export interface JzScalarMemory {
  readonly scalar: true
  read(value: JzCarrier | readonly JzCarrier[]): unknown
}

export type JzExports = Record<string, any>

export interface JzInstance<E extends JzExports = JzExports> {
  exports: E
  memory: JzMemory | null
  instance: WebAssembly.Instance
  module: WebAssembly.Module
}

export interface MemoryFactory {
  (): JzMemory
  (memory: WebAssembly.Memory): JzMemory
  (descriptor: WebAssembly.MemoryDescriptor): JzMemory
  (instance: JzInstance): JzMemory | JzScalarMemory
}

/** Compile and instantiate: `jz(source, opts)` or ``jz`source` ``; `jz.memory()` makes a memory modules share. */
export interface Jz {
  (code: string, opts?: CompileOptions & { wat?: false }): JzInstance
  (strings: TemplateStringsArray, ...values: unknown[]): JzInstance
  memory: MemoryFactory
}

declare const jz: Jz
export default jz

export function compile(code: string, opts: CompileOptions & { wat: true }): string
export function compile(code: string, opts?: CompileOptions & { wat?: false }): CompiledWasm
export function compile(code: string, opts?: CompileOptions): CompiledWasm | string

/** Options of `instantiate`. */
export interface InteropOptions {
  /** Host modules for the module's `import { fn } from "mod"` declarations. */
  imports?: Record<string, unknown>
  /** Memory to link instead of the module's own export. */
  memory?: WebAssembly.Memory
  /** WASI stdout/stderr and stdin for `host: 'wasi'` modules. */
  write?: (fd: number, text: string) => void
  read?: (fd: number, buffer: Uint8Array) => number | void
}

/** Instantiate prebuilt jz wasm: marshals values, decodes errors, links WASI when present. */
export function instantiate(
  wasm: WebAssembly.Module | Uint8Array | ArrayBuffer,
  opts?: InteropOptions,
): JzInstance
