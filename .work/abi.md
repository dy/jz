# Wasm interfaces: how a module talks to its host

Core wasm passes only numbers across the boundary: `i32 i64 f32 f64 v128`, plus
references with the reference-types and GC proposals. Everything richer (a string,
an array, an object, a file) is a convention both sides agree on: an ABI. Three
layers get confused:

1. **Value ABI**: how a string or object crosses between module and host.
2. **System interface**: how the module reaches stdio, files, clocks.
3. **Packaging**: how typed interfaces are declared and linked.

## The approaches

| Approach | Who | How values cross | Host glue | Runs on | Per-call cost | Standard |
|---|---|---|---|---|---|---|
| Raw core ABI: numbers + pointers into memory | jz `alloc: false`, AssemblyScript `--runtime stub`, hand-written C | numbers; the host reads the memory layout itself | none | every engine | lowest | core wasm |
| WASI Preview 1 (`wasi_snapshot_preview1`) | jz `--host wasi`; rustc `wasm32-wasip1`, clang/zig `wasm32-wasi`, tinygo `wasip1`, emcc `-sSTANDALONE_WASM` | bytes through fds (`fd_write`, `fd_read`), pointers into linear memory | the runtime's (wasmtime, wasmer, `node:wasi`, browser shims, wasm2c + a C shim) | the widest set | one call per syscall | de facto; a frozen snapshot, never finalized |
| jz JS ABI | jz `--host js` (default) | NaN-boxed i64: a number as itself, a heap value as a tagged pointer; `interop.js` copies strings, arrays, objects out | `jz/interop`, 20 KB gz, from the jz that built the module | JS hosts | numbers free, heap values copied | jz only |
| wasm-bindgen | Rust `wasm32-unknown-unknown` | generated lift/lower per signature, `__wbindgen_*` imports | generated JS; the CLI version must equal the crate's | JS hosts | strings copied | Rust only |
| Emscripten | C/C++ via emcc | its own `env` imports (`__syscall_*`, `emscripten_*`); embind for classes | generated JS, tied to the emcc version that built it | browser, Node | varies | emcc only |
| Go `syscall/js` | Go `GOOS=js`, TinyGo | a reference table in `wasm_exec.js` | `wasm_exec.js`, large binaries | JS hosts | high (boxed refs) | Go only |
| WasmGC + externref + JS String Builtins | Kotlin/Wasm, Dart, MoonBit (gc), js2wasm | by reference, no copy; a string stays a JS string | thin | engines with GC; no native path through wasm2c | lowest for strings | core proposals |
| Component Model + WIT + Canonical ABI | wasmtime, jco, `cargo component`, ComponentizeJS | language-neutral types (`string list record variant resource`), copied by lift/lower | the runtime's; in a browser, jco transpiles to core wasm + JS glue | wasmtime family; browsers only through jco | copies at every boundary | the one standard for rich values; not in browsers |

jz rows: `TARGET_PROFILES` in [src/session.js](../src/session.js) (`js`, `wasi`,
`native`), [interop.js](../interop.js), README "Stability". Other rows: knowledge as of
mid-2026 except where a source is linked below; verify before quoting publicly.

## Is there a standard?

- **System access**: WASI Preview 1, de facto. Every runtime and wasm2c speak it.
  WASI 0.2 and 0.3 are component-based: 0.3.0 was released 2026-06-11 with native
  async; wasmtime 46+ runs 0.3 components, jco has only an experimental Node shim,
  and most toolchains still target 0.2 ([wasi.dev/releases](https://wasi.dev/releases)).
- **Rich values across languages**: the Component Model, the only candidate. No
  browser runs components natively.
- **Rich values with a JS host**: none, except strings. JS String Builtins shipped
  in Chrome 130 and Firefox 134; Safari support is listed from 26.2, and the feature
  was not yet Baseline at the last snapshot
  ([web-features](https://web-platform-dx.github.io/web-features-explorer/features/wasm-string-builtins)).

## WasmGC does not solve JS arrays

A JS Array and a WasmGC array are separate heaps. JS cannot hand an Array to wasm as
a GC array; it is copied element by element through exported functions. Under the GC
proposal's MVP JS API, a GC struct or array reaches JS as an opaque wrapper: no
indexing, no fields. The custom-descriptors proposal adds JS prototypes so JS can
call methods on a struct, not read its fields; it is at Phase 1
([custom-descriptors](https://github.com/WebAssembly/custom-descriptors)).

What does cross without a copy: a typed array viewing the module's linear memory
(`memory.Float64Array` in jz), and, with String Builtins, a JS string held as
externref. jz's strings live in linear memory, so String Builtins would help only if
jz changed its string representation.

## The C round trip: jz → wasm → wasm2c → C → wasm

The C that wasm2c emits can be compiled back to wasm. Its interface is whatever the C
toolchain links:

- **wasi-libc** (zig cc, wasi-sdk) with [scripts/native/wasi.c](../scripts/native/wasi.c)
  as the import shim: a WASI Preview 1 module. That is the ABI `--host wasi` emits
  directly.
- **emcc**: the Emscripten ABI and its JS glue, or WASI P1 under `-sSTANDALONE_WASM`.

Either way the result wraps a linear memory inside a linear memory: the inner
module's memory becomes a buffer the C runtime allocates in the outer one. wasm2c's
runtime drops explicit bounds checks only with guard pages, which needs a 64-bit host
with mmap; elsewhere it checks every access explicitly
([wasm-rt.h](https://searchfox.org/mozilla-central/source/third_party/wasm2c/wasm2c/wasm-rt.h)).
A wasm32 target is such a case. So the round trip gives no ABI jz lacks (WASI P1 is
`--host wasi`; Emscripten's is a less standard one) and adds a bounds check per
access. Not measured.

The bench's `c-wasm`, `rust-wasm`, `zig-wasm` and `tinygo` lanes are WASI P1 modules
([bench/bench.mjs](../bench/bench.mjs)), not Emscripten.

## For jz

Goal: standard, minimal, broad support.

- **Compute**: numbers and typed-array views of linear memory. Core wasm, no glue,
  every engine, zero copy. jz's strongest ground (DSP kernels, `memory: { fixed }`).
- **I/O and portability**: WASI Preview 1 (`--host wasi`). Runs in browsers through a
  shim, in wasmtime, and natively through wasm2c.
- **Rich values with a JS host**: the jz JS ABI. The one non-standard piece, kept
  because nothing standard exists for this without GC, and GC does not cover JS
  arrays.
- **Not now**: Component Model output (no browser runs it; a third glue layer no user
  asks for), WasmGC values (separate heap from JS, no wasm2c path), versioning the
  interop (jz is experimental; revisit when users report breakage).
- **Untested angle**: an export taking and returning only numbers or typed arrays
  maps onto WIT `f64` / `list<f64>` almost directly, so a component wrapper for such
  exports would be a description, not a new ABI.
