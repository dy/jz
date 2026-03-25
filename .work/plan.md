# Architecture Plan: jz → WASM-compilable JS for DSP

## Principle

> "I am the taste of water" — find the irreducible essence.

Write natural JS, compile to optimal WASM. The API surface is just JS. Each compilation targets one explicit ABI profile.

## Current state (scratch branch)

**Working** (~580 lines core, 116 tests passing):
- ctx.js → index.js → prepare.js → compile.js pipeline (no circular deps)
- Scalar profile: arithmetic, comparisons, ternary, single-expression functions
- Multi profile: `return [a, b, c]` → `(result f64 f64 f64)` multi-value
- Block bodies: let/const, if/else, for, while, break/continue, return
- Logical operators: &&, || with short-circuit
- Math module (35+ functions)
- Module system (import/auto-import/namespace)
- Function signature model: `sig = { params: [{name, type}], results: [type] }`
- CLI working (`jz "1+2"` → `3`)
- README matches reality

**Missing for DSP**:
- Memory operations (array indexing) — requires ABI changes, not just a module

**Not yet wired** (exist, need adapting for new arch):
- stdlib.js — WAT implementations of standard JS (math, array, string ops)
- core.js, binary.js — assume NaN-boxed pointers, need rewrite for new pointer strategy

## Integration targets

**color-space**: Pure scalar math, 3-in → 3-out. pow/cbrt/sin/cos, inline 3×3 matrix multiply.
```js
export let rgb2xyz = (r, g, b) => [
  r * 0.4124 + g * 0.3576 + b * 0.1805,
  r * 0.2126 + g * 0.7152 + b * 0.0722,
  r * 0.0193 + g * 0.1192 + b * 0.9505
]
// → (func (param f64 f64 f64) (result f64 f64 f64) ...)
```

**digital-filter**: Array processing, in-place mutation, filter state.
```js
export let gain = (buf, len, g) => {
  for (let i = 0; i < len; i++) buf[i] = buf[i] * g
}
// → (func (param i32 i32 f64) ... f64.load/f64.store ...)
```

## ABI profiles

### Revised understanding

"Profile" is the wrong abstraction. There's no scalar/multi/memory mode.

- **Internal**: always fastest representation. Memory for arrays. Multi-value for tuples. i32/f64 by operator.
- **Boundary** (JS↔WASM exports): configurable per-compilation — how complex data crosses the edge.

| Boundary option | Arrays in | Tuples out | Best for |
|----------------|-----------|------------|----------|
| **multi-value** | not supported | `(result f64 f64 f64)` | fixed-size returns (color-space) |
| **memory pointer** | i32 offset+len | i32 offset | large buffers (audio DSP) |
| **GC struct** | GC array/struct | GC struct | clean JS interop |

The `{ profile: 'multi' }` flag currently controls multi-value returns. This will evolve into a boundary convention option rather than a global mode. See research.md "Data representation" for full analysis.

### Memory management

Allocator is a pluggable contract, not hardcoded:
- **Bump (arena)**: simplest, reset all at once. Default. Good for DSP batch processing.
- **Free list**: individual alloc/free. For mixed lifetimes.
- **WASM GC**: host engine manages. For non-realtime, clean interop.

Export `_alloc(bytes) → i32` and `_reset()` or `_free(ptr)` — implementation swappable.

## Phases

### Phase 0: Honesty ✓

### Phase 1: Scalar compiler ✓

Block bodies, let/const, assignment ops, if/else, for/while, break/continue, &&/||, return.

### Phase 1.5: Function signature model ✓

`sig = { params: [{name, type}], results: [type] }` — populated by prepare, consumed by compile. Data-driven ABI.

### Phase 2: Multi-value return ✓

`return [a, b, c]` → `(result f64 f64 f64)`. Expression and block bodies. Profile validation. rgb2xyz pattern validated.

### Phase 3: Memory mode (ABI change)

Real backend work:
- compile.js: emit i32 params for memory pointers (reads from sig.params[i].type)
- compile.js: emit `f64.load`/`f64.store` for `buf[i]` access
- compile.js: emit memory section, heap global, `_alloc`/`_reset`
- prepare.js: track which params are used as arrays → sets param type to i32
- Requires `{ profile: 'memory' }` — enables i32 params, memory section

Wire stdlib.js WAT into modules where needed.
Rewrite core.js/binary.js for i32 offset pointers.

**Validation**: compile biquad filter from digital-filter.

### Phase 4: Product-driven features

Not one block. Split by what downstream products pull in:

**4a: floatbeat** — the first real user
- Statement bodies from Phase 1 + math module = sufficient
- Single-page demo, waveform display, preset formulas
- Proves the scalar profile end-to-end

**4b: color-space/wasm**
- Multi profile from Phase 2
- Compile actual color-space conversions
- Publish as package

**4c: digital-filter/wasm**
- Memory profile from Phase 3
- Compile actual biquad/SVF filters
- Benchmark vs plain JS

**4d: standard JS support** (as needed by above)
- String ops, array methods — pulled in by product need, not for completeness
- WASI host imports — when a product needs console/Date
- Re-enable test files as features land

### Research: GC mode

Separate from mainline. Experiment when multi+memory are proven:
- GC structs at JS boundary (auto-named `$t3` etc)
- GC arrays for JS↔WASM interop
- May simplify JS-side wrappers significantly

## What stays minimal

The gem: parse → prepare → compile pipeline + module seam.

The signature model (Phase 1.5) is the key new abstraction — it sits between prepare and compile, making ABI variation data-driven rather than hardcoded. Everything else flows from it.

Modules extend via ctx.emit + ctx.stdlib for emitter patterns (math, constants). Profile/ABI is a compile-level concern driven by function signatures.

Core target: <2K lines for scalar + multi + memory.
