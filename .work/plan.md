# Architecture Plan: jz → WASM-compilable JS for DSP

## Principle

> "I am the taste of water" — find the irreducible essence.

Write natural JS, compile to optimal WASM. The API surface is just JS. Each compilation targets one explicit ABI profile.

## Current state (scratch branch)

**Working** (~480 lines core):
- parse → prepare → compile → watr pipeline
- Single-expression arrow functions, all f64
- Math module (35+ functions, all tested, 83/85 pass)
- Module system (import/auto-import/namespace)
- Prohibited feature detection
- CLI working (`jz "1+2"` → `3`)

**Missing for DSP**:
- Statement bodies (for, if/else, let/const within functions)
- Local variable emission, assignment operators
- Control flow (loops, break/continue)
- Multi-value return (tuple outputs)
- Memory operations (array indexing) — requires ABI changes, not just a module

**Not yet wired** (exist, need adapting for new arch):
- stdlib.js — WAT implementations of standard JS (math, array, string ops)
- core.js, binary.js — assume NaN-boxed pointers, need rewrite for new pointer strategy

**External clarity gaps**:
- README now matches reality (scalar math, math module, arrow functions)
- `modules` option documented in index.js JSDoc but never read from opts (auto-import handles it)

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

Three profiles, explicitly chosen per compilation. No silent promotion.

| Profile | Params | Returns | Best for |
|---------|--------|---------|----------|
| **scalar** | all f64 | single f64 | single-value math (current) |
| **multi** | all f64 | `(result f64 f64 f64)` | tuples, color-space |
| **memory** | f64 + i32 pointers | f64 | array processing, DSP |

### Tuple return rule

`return [a, b, c]` with array literal is a **compile error in scalar profile**. It requires multi profile explicitly:
```js
jz(code)                    // scalar: return [a,b,c] → error
jz(code, { profile: 'multi' })  // multi: return [a,b,c] → (result f64 f64 f64)
```
No silent promotion. User knows which ABI they're targeting.

### Decisions

- **Memory mode is explicit** — param used with `[i]` compiles as i32 pointer. This changes function signature — backend work, not a module.
- **GC is research** — not in mainline until multi+memory are proven.
- **Memory management is a contract** — bump allocator default. Export `_alloc(bytes) → i32` and `_reset()` (arena-style, not per-allocation free).
- **WASI-aware from the start** — host imports designed to be WASI-compatible.

### JS-side for memory mode

Standard approach, no special class:
```js
const { memory, _alloc, _reset, gain } = instance.exports
const ptr = _alloc(1024 * 8) // 1024 f64s
const buf = new Float64Array(memory.buffer, ptr, 1024)
buf.set(inputData)
gain(ptr, 1024, 0.5)
// buf now contains processed data
_reset() // release all allocations
```

## Phases

### Phase 0: Honesty ✓

- ~~cli.js: fix broken import~~ Done
- ~~README: strip to what actually works~~ Done
- Remove unused `modules` JSDoc from index.js (or wire it up)

### Phase 1: Scalar compiler

Add to compile.js emitter:
- Multiline function bodies (block statements `{ }`)
- `let`/`const` in bodies → `local` declarations + `local.set`
- `=`, `+=`, `-=` etc → `local.set` / `local.tee`
- `if`/`else` → WASM `if/then/else`
- `for` → `loop/block/br_if`
- `break`/`continue` → `br`
- `&&`/`||` → short-circuit
- `return` → function body result

**Validation**: compile `lrgb2rgb` from color-space (gamma with pow + conditionals).

### Phase 1.5: Function signature model

Before multi or memory can work, compile.js needs a real signature model:
- Replace hardcoded `['param', '$p', 'f64']` / `['result', 'f64']` with per-function signature metadata
- `ctx.funcs[i].sig = { params: [{name, type}], results: [type] }` — populated by prepare, consumed by compile
- Profile validation: scalar profile rejects multi-return, memory profile allows i32 params
- This is the seam that Phase 2 and Phase 3 build on

Currently index.js:27 only stores param names. compile.js:28 hardcodes f64. This must become data-driven before ABI can vary per-function.

### Phase 2: Multi-value return

- `return [a, b, c]` with array literal → `(result f64 f64 f64)`
- prepare.js detects fixed-length array return → sets `sig.results = ['f64', 'f64', 'f64']`
- compile.js reads sig.results (no longer hardcoded)
- Requires `{ profile: 'multi' }` — error in scalar profile
- Still all f64 params — no ABI change on input side

**Validation**: compile `rgb2xyz`, `xyz2lab` from color-space.

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
