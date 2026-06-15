// Type declarations for jz — minimal functional JS subset compiling to WASM.
// The public surface is small: `jz` (compile + instantiate), `compile` (raw bytes),
// `compileModule` (compile once), `instantiate` (run a module), and `jz.memory`.
// See README for semantics and the JS↔WASM value ABI.

/** Optimization level / preset. `2` is the default (all stable passes). */
export type OptimizeLevel = boolean | 0 | 1 | 2 | 3 | 'speed' | 'size'

/** Runtime-service lowering target. */
export type Host = 'js' | 'wasi'

/** Value injectable as a compile-time `define` constant. */
export type DefineValue = number | boolean | string | null | DefineValue[] | { [k: string]: DefineValue }

export interface CompileOptions {
  /** Static ES imports to bundle: `{ './dep.js': 'export let x = 1' }`. */
  modules?: Record<string, string>
  /** Host imports wired at runtime: `{ math: Math, host: { log: console.log } }`. */
  imports?: Record<string, unknown>
  /** `N` initial pages of owned memory, or a shared `jz.memory()` / `WebAssembly.Memory`. */
  memory?: number | WebAssembly.Memory | JzMemory
  /** Cap memory growth at this many 64 KiB pages (default: unbounded). */
  maxMemory?: number
  /** Import `env.memory` instead of exporting own memory. */
  importMemory?: boolean
  /** Runtime-service lowering. Default `'js'`. */
  host?: Host
  /** Optimization level or named preset. Default `2`. */
  optimize?: OptimizeLevel
  /** Compile-time constants injected as top-level bindings. */
  define?: Record<string, DefineValue>
  /** Enforce the pure canonical subset: skip jzify lowering and reject dynamic fallbacks. */
  strict?: boolean
  /** Omit `_alloc`/`_clear` allocator exports for standalone scalar modules. */
  alloc?: boolean
  /** Disable auto-vectorization (no jz-emitted `v128`). Explicit intrinsics still compile. */
  noSimd?: boolean
  /** Use ordinary call frames instead of `return_call` tail calls. */
  tailCall?: boolean
  /** `Math.random` seeding: a number fixes the stream; `true` forces host entropy. */
  randomSeed?: number | boolean
  /** Emit a WASM `name` section (function symbols) for profilers/debuggers. */
  names?: boolean
  /** `compile()` returns WAT text instead of a WASM binary. */
  wat?: boolean
  /** Resolve bare specifiers via Node.js module resolution (CLI/build use). */
  resolve?: boolean
  /** Mutable sink that collects per-stage compile timings. */
  profile?: { entries?: unknown[]; totals?: Record<string, number> } & Record<string, unknown>
}

/**
 * An enhanced `WebAssembly.Memory` that marshals JS values across the WASM boundary.
 * Allocators (`String`/`Array`/`Object`/typed-array ctors) return NaN-boxed `f64`
 * pointers; `read` decodes one back. The heap never frees implicitly — call `reset`
 * between independent batches (all previously returned pointers become invalid).
 */
export interface JzMemory extends WebAssembly.Memory {
  /** Allocate a UTF-8 string; returns a pointer. */
  String(str: string): number
  /** Allocate an array (numbers, strings, nested arrays/objects); returns a pointer. */
  Array(data: ArrayLike<unknown>): number
  /** Allocate a fixed-layout object (keys must match a compiled schema); returns a pointer. */
  Object(obj: Record<string, unknown>): number
  Float64Array(data: ArrayLike<number>): number
  Float32Array(data: ArrayLike<number>): number
  Int32Array(data: ArrayLike<number>): number
  Uint32Array(data: ArrayLike<number>): number
  Int16Array(data: ArrayLike<number>): number
  Uint16Array(data: ArrayLike<number>): number
  Int8Array(data: ArrayLike<number>): number
  Uint8Array(data: ArrayLike<number>): number
  /** Decode one pointer (or a multi-value tuple of pointers) back to a JS value. */
  read(ptr: number | number[]): unknown
  /** Reserve `bytes` of raw heap; returns the offset. */
  alloc(bytes: number): number
  /** Rewind the bump pointer — drops every allocation since the last reset. */
  reset(): void
}

/** A compiled-and-instantiated jz module. */
export interface JzInstance {
  /** JS-wrapped exports: marshals arguments in, decodes pointer returns, throws real `Error`s. */
  exports: Record<string, (...args: any[]) => any> & Record<string, any>
  /** The value codec, or `null` for a pure-scalar module with no heap. */
  memory: JzMemory | null
  /** The raw `WebAssembly.Instance` (numbers pass through; pointers come back NaN-boxed). */
  instance: WebAssembly.Instance
  /** The underlying `WebAssembly.Module`. */
  module: WebAssembly.Module
}

/** Create a shared memory that modules compile into (schemas accumulate across modules). */
export interface MemoryFactory {
  (src?: WebAssembly.Memory): JzMemory
}

/** The default export: compile + instantiate, as a call or a tagged template. */
export interface Jz {
  /** Compile and instantiate a source string. */
  (code: string, opts?: CompileOptions): JzInstance
  /** Tagged-template form: interpolations are baked into the source at compile time. */
  (strings: TemplateStringsArray, ...values: unknown[]): JzInstance
  /** Compile only — raw WASM binary (or WAT text with `{ wat: true }`). */
  compile: typeof compile
  /** Shared-memory factory: `jz.memory()` or `jz.memory(existing)`. */
  memory: MemoryFactory
}

declare const jz: Jz
export default jz
export { jz }

/** Compile to a raw WASM binary. */
export function compile(code: string, opts?: CompileOptions & { wat?: false }): Uint8Array
/** Compile to WAT text. */
export function compile(code: string, opts: CompileOptions & { wat: true }): string

/** Compile once to a `WebAssembly.Module` (pays AOT + validate cost once); instantiate many. */
export function compileModule(code: string, opts?: CompileOptions): WebAssembly.Module

/** Instantiate a compiled module or raw WASM bytes, wiring the allocator and value codec. */
export function instantiate(
  module: WebAssembly.Module | Uint8Array | ArrayBuffer,
  opts?: CompileOptions,
): JzInstance
