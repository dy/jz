# Stability — the v1 public surface

What the first stable major will commit to. Anything not listed here is
internal or experimental and may change without notice before v1. Within a
stable major, listed items change only additively; removals or meaning changes
require a major bump.

## The semantics contract

**Correct within the documented dialect, or reject.** JZ accepts ordinary
JavaScript source but deliberately gives a finite set of constructs native,
machine-level semantics: wrapping i32 and i64 arithmetic, UTF-8 string
positions, fixed object shapes, byte-oriented dynamic keys and indices, manual
memory lifetime, host-boundary job scheduling, and the other cases enumerated
under [“What differs from JS?”](README.md#what-differs-from-js). Those listed
differences are part of the language contract; they are not claims of exact
ECMAScript behavior.

Outside that explicit list, an accepted program must preserve JavaScript's
answers, exceptions, operand order, and effects at every optimization level.
Where the compiler cannot do so, it must reject rather than silently choose a
representation or value. Any unlisted silent wrong value is release-blocking.

The parser now validates structural scopes/targets/control flow plus lexical
numeric, string, template, RegExp, identifier, class, and module errors before
jzify, natively and in `jz.wasm`. On the pinned test262 language corpus it
rejects 3,858 applicable negative-parse files and still accepts exactly 187;
every residual path is family-classified and exact-set-gated in
`test/test262-neg-accepts.json`. Those residuals have no compatibility guarantee
and remain a v1 release gate, never a supported extension.

## Package surface (`jz` on npm)

Entry points (package.json `exports`):

- `jz` — `jz(code, opts?)` default export → `{ exports, memory, instance,
  module }`; tagged-template form supported. `jz.pool` is the shared-memory
  worker pool. Named: `compile(code, opts?)` → `Uint8Array` (or WAT `string`
  with `{wat: true}`; `{inspect: true}` wraps either as `{wasm|wat, inspect}`),
  `compileModule`, `instantiate`, `transform`, `resolveWatrOpts`. The inspect
  payload and the object returned by `resolveWatrOpts` are not stable.
- `jz/interop` — the supported host bridge: `instantiate`, `toModule`, and
  `memory`. Enhanced memory exposes `String`, `Array`, `Object`, `Hash`,
  `Buffer`, `BigInt`, `External`, typed-array allocators, `read`, `wrapVal`,
  `write`, `alloc`, `allocTyped`, and `reset`. Lower-level exports remain
  available for expert use but are experimental as described below.
- `jz/wasi`, `jz/transform` — as documented in README.
- TypeScript declarations for the root and every exported subpath.

Marshalling policy at the host boundary: plain BigInt values cross only at
slots with compiler-emitted evidence (see ABI below); everywhere else they
reject with a typed `TypeError` — never a silent string or bit
reinterpretation.

## CLI (`jz`, bin → cli.js)

Stable commands and flags: `jz <file.js>`, `--strict`, `--jzify`, `-e`,
`--output/-o` (`.wat`, `.wasm`, `-`), `-O0..3`/`-Os`/`-Ofast`/`--optimize`,
`--define/-D K=V` (repeatable), `--host js|wasi|native`, `--memory <pages>`,
`--max-memory <pages>`, `--import-memory`, `--no-alloc`, `--no-simd`,
`--why-not-simd`, `--stencil`, `--outer-strip`, `--no-tail-call`,
`--no-eh-abort`, `--names`, `--stats`, `--help/-h`. New flags may be added;
listed flags keep their meaning.

## Experimental raw Wasm ABI

The high-level wrapper API is the v1 embedder contract, but prebuilt binaries
must currently be consumed by the same JZ version that produced them. Direct
consumption of raw Wasm is intentionally not frozen yet: emitted binaries carry
no independent ABI version marker, and a future carrier/layout redesign
(including wasm64) must not be trapped by an accidental pre-v1 promise.

For current-toolchain integrations, `jz:hostabi` records per-export BigInt
argument policy and `jz:i64exp` records i64-carried parameters/results. The
NaN-box helpers in `jz/interop`, `_alloc`/`_clear`, schema ids, custom-section
payloads, and carrier bit layout are internally consistent and regression-tested
for each build, but are not cross-release compatibility interfaces. Use
`jz/interop.instantiate()` unless the consumer pins the exact JZ version. A
future stable raw ABI requires an explicit version marker and decoder contract.

## Error contract

Error **classes and codes** are stable; message **text** is not (messages
may keep improving — pin behavior, not prose). Registration-time integrity
is guarded: a module silently overwriting another's flat emitter
registration is a loud error at compile-tool startup, not a latent
miscompile.

## Explicitly not stable

`_setCompileTarget` and any `_`-prefixed export; the `inspect` payload and
`resolveWatrOpts` result shape; the low-level `jz/interop` exports `wrap`,
`coerce`, `f64ToI64`, `i64ToF64`, `ptr`, `offset`, `type`, `aux`, and the four
`*_NAN` constants; raw Wasm custom sections and allocator exports;
compiled-module internal layout (NaN-box bit patterns, schema ids, function
names beyond exported ones — the name section is opt-in via `--names`);
`.work/` documents; kernel (`dist/jz.wasm`) byte identity between releases.

## Known limitations at v1

- **In-wasm self-compilation of jz itself** (jz.wasm compiling jz's own
  6.4 MB source inside wasm32) exceeds the 4 GiB address space and traps.
  The supported build path for jz's own kernel is the native (Node)
  toolchain, which is how `dist/` ships. Measured attribution and the
  scoped path to closing this (result-kind provenance) live in
  `.work/research.md`; user programs do not approach this wall.
- **Ambiguous `boolean∪number` locals** whose stored identity would escape
  reject at compile time (truthiness-only uses compile fine); full support
  needs a tagged Boolean carrier plan.
- **Rest-parameter BigInt elements** have no reachable evidence today and
  reject per the marshalling policy.
